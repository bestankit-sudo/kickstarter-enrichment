import axios, { AxiosError } from "axios";
import { sleep, withExponentialBackoff } from "../utils/rate-limiter.js";

export type ProxycurlPerson = {
  roleFinal: "CEO" | "Founder" | "CTO" | "COO" | "CMO";
  linkedinProfileUrl: string;
  fullName: string;
  firstName: string;
  lastName: string;
  occupation: string;
  headline: string;
  country: string;
};

const roleMap: Record<string, ProxycurlPerson["roleFinal"]> = {
  ceo: "CEO",
  founder: "Founder",
  "co-founder": "Founder",
  cto: "CTO",
  coo: "COO",
  cmo: "CMO",
};

const getRoleCandidates = (roleTarget: "CEO_FOUNDER" | "CTO" | "COO_CMO"): string[] => {
  if (roleTarget === "CEO_FOUNDER") {
    return ["ceo", "founder", "co-founder"];
  }
  if (roleTarget === "CTO") {
    return ["cto"];
  }
  return ["coo", "cmo"];
};

export async function findPersonByRole(
  apiKey: string,
  companyName: string,
  roleTarget: "CEO_FOUNDER" | "CTO" | "COO_CMO",
): Promise<{ person: ProxycurlPerson | null; sourceNotes: string }> {
  const roles = getRoleCandidates(roleTarget);

  for (const role of roles) {
    try {
      const response = await withExponentialBackoff(
        () =>
          axios.get("https://nubela.co/proxycurl/api/find/company/role/", {
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
            params: {
              role,
              company_name: companyName,
              enrich_profile: "enrich",
            },
            timeout: 15_000,
          }),
        {
          retries: 5,
          initialDelayMs: 2000,
          maxDelayMs: 60_000,
          shouldRetry: (error) => {
            const axiosError = error as AxiosError;
            const status = axiosError.response?.status;
            if (status === 404) {
              return false;
            }
            if (status === 429) {
              return true;
            }
            return typeof status === "number" && status >= 500;
          },
        },
      );

      const data = response.data as {
        linkedin_profile_url?: string;
        profile?: {
          full_name?: string;
          first_name?: string;
          last_name?: string;
          occupation?: string;
          headline?: string;
          country?: string;
        };
      };

      return {
        person: {
          roleFinal: roleMap[role],
          linkedinProfileUrl: data.linkedin_profile_url || "",
          fullName: data.profile?.full_name || "",
          firstName: data.profile?.first_name || "",
          lastName: data.profile?.last_name || "",
          occupation: data.profile?.occupation || "",
          headline: data.profile?.headline || "",
          country: data.profile?.country || "",
        },
        sourceNotes: `proxycurl_role:${role}`,
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      if (status === 404) {
        await sleep(50);
        continue;
      }

      return {
        person: null,
        sourceNotes: `Proxycurl error (${status ?? "unknown"})`,
      };
    }
  }

  return {
    person: null,
    sourceNotes: "Proxycurl returned no role match",
  };
}
