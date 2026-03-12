import axios, { AxiosError } from "axios";
import { RequestQueue, sleep } from "../utils/rate-limiter.js";

export type EmailLookupResult = {
  email: string | null;
  emailStatus: "verified" | "risky" | "not_found";
  sourceNotes: string;
  rawResponse: Record<string, unknown> | null;
};

const queue = new RequestQueue(400);

const mapStatus = (raw: string): "verified" | "risky" => {
  const lower = raw.trim().toLowerCase();
  if (lower === "verified") {
    return "verified";
  }
  return "risky";
};

export async function findWorkEmail(input: {
  appDomain: string;
  authKey: string;
  authSecret: string;
  domain: string;
  firstName: string;
  lastName: string;
}): Promise<EmailLookupResult> {
  return queue.schedule(async () => {
    let attempt = 0;

    while (attempt <= 3) {
      attempt += 1;
      try {
        const response = await axios.post(
          `https://${input.appDomain}/v2/email-finder`,
          {
            domain: input.domain,
            fname: input.firstName,
            lname: input.lastName,
          },
          {
            timeout: 15_000,
            headers: {
              Authorization: `Bearer ${input.authKey}.${input.authSecret}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
          },
        );

        const data = response.data as {
          response?: {
            email?: string;
            status?: string;
          };
        };

        const status = data.response?.status || "Risky";
        return {
          email: data.response?.email || null,
          emailStatus: mapStatus(status),
          sourceNotes: `emailapi_status:${status}`,
          rawResponse: (data.response as Record<string, unknown> | undefined) ?? null,
        };
      } catch (error) {
        const axiosError = error as AxiosError;
        const status = axiosError.response?.status;
        if (status === 404) {
          return {
            email: null,
            emailStatus: "not_found",
            sourceNotes: "EmailAPI 404 not found",
            rawResponse: null,
          };
        }

        if (status === 422) {
          return {
            email: null,
            emailStatus: "not_found",
            sourceNotes: "EmailAPI 422 bad request",
            rawResponse: null,
          };
        }

        if (status === 429 && attempt <= 3) {
          await sleep(1000 * attempt);
          continue;
        }

        if (attempt <= 3) {
          await sleep(750 * attempt);
          continue;
        }

        return {
          email: null,
          emailStatus: "not_found",
          sourceNotes: `EmailAPI error (${status ?? "unknown"})`,
          rawResponse: null,
        };
      }
    }

    return {
      email: null,
      emailStatus: "not_found",
      sourceNotes: "EmailAPI retry limit reached",
      rawResponse: null,
    };
  });
}
