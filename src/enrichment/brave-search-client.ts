import axios, { AxiosError } from "axios";
import { withExponentialBackoff } from "../utils/rate-limiter.js";
import { logger } from "../utils/logger.js";
import type { NormalizedFounder } from "../lib/ai-normalizer.js";

export type SerpCandidate = {
  linkedinUrl: string;
  name: string;
  query: string;
};

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

const LINKEDIN_IN_REGEX = /https?:\/\/(www\.)?linkedin\.com\/in\/[^/"'\s?#]+/gi;

function simplifyCompanyName(name: string): string {
  return name
    .replace(/\s*\(.*?\)\s*/g, " ")        // strip parenthetical like "(VSSL Gear)"
    .replace(/\b(Inc\.?|LLC|Ltd\.?|Co\.?|Corp\.?|Pty|GmbH|S\.?A\.?|formerly)\b/gi, "")
    .replace(/[,;]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildQueries(
  companyName: string,
  founders: NormalizedFounder[],
): string[] {
  const queries: string[] = [];
  const simplified = simplifyCompanyName(companyName);

  // Use both full and simplified names, deduplicated
  const names = [companyName];
  if (simplified !== companyName && simplified.length >= 3) {
    names.push(simplified);
  }

  for (const founder of founders) {
    if (founder.first_name && founder.last_name) {
      queries.push(
        `"${founder.first_name} ${founder.last_name}" "${names[0]}" site:linkedin.com/in`,
      );
    }
  }

  for (const name of names) {
    queries.push(`"${name}" founder site:linkedin.com/in`);
    queries.push(`"${name}" CEO site:linkedin.com/in`);
  }

  queries.push(`"${names[0]}" partnerships site:linkedin.com/in`);
  queries.push(`"${names[0]}" marketing site:linkedin.com/in`);

  return queries;
}

function extractLinkedInUrls(results: Array<{ url?: string; title?: string }>): SerpCandidate[] {
  const candidates: SerpCandidate[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    const url = result.url ?? "";
    const matches = url.match(LINKEDIN_IN_REGEX);
    if (matches) {
      for (const match of matches) {
        const normalized = match.replace(/\/+$/, "").toLowerCase();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          candidates.push({
            linkedinUrl: match.replace(/\/+$/, ""),
            name: result.title?.replace(/ - LinkedIn.*$/i, "").replace(/\s*\|.*$/, "").trim() || "",
            query: "",
          });
        }
      }
    }
  }

  return candidates;
}

export async function findLinkedInProfiles(
  apiKey: string,
  companyName: string,
  founders: NormalizedFounder[],
): Promise<SerpCandidate[]> {
  if (!companyName) return [];

  const queries = buildQueries(companyName, founders);

  for (const query of queries) {
    try {
      const response = await withExponentialBackoff(
        () =>
          axios.get(BRAVE_SEARCH_URL, {
            headers: {
              Accept: "application/json",
              "Accept-Encoding": "gzip",
              "X-Subscription-Token": apiKey,
            },
            params: {
              q: query,
              count: 5,
            },
            timeout: 10_000,
          }),
        {
          retries: 2,
          initialDelayMs: 1000,
          maxDelayMs: 10_000,
          shouldRetry: (error) => {
            const axiosError = error as AxiosError;
            const status = axiosError.response?.status;
            return status === 429 || (typeof status === "number" && status >= 500);
          },
        },
      );

      const webResults = (response.data?.web?.results ?? []) as Array<{
        url?: string;
        title?: string;
      }>;

      logger.info(`[brave-search] "${query}" → ${webResults.length} web results`);

      const candidates = extractLinkedInUrls(webResults);

      if (candidates.length === 1) {
        return [{ ...candidates[0], query }];
      }

      if (candidates.length > 1) {
        return candidates.slice(0, 3).map((c) => ({ ...c, query }));
      }
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.warn(
        `[brave-search] Query failed: "${query}" — ${axiosError.message}`,
      );
    }
  }

  return [];
}
