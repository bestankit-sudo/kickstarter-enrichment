import axios, { AxiosError } from "axios";
import { withExponentialBackoff } from "../utils/rate-limiter.js";
import { logger } from "../utils/logger.js";

// ─── Types ───

export type ApolloSearchResult = {
  id: string;
  first_name: string;
  title: string;
  organization_name: string;
  has_email: boolean;
};

export type ApolloPerson = {
  id: string;
  first_name: string;
  last_name: string;
  name: string;
  title: string;
  headline: string;
  linkedin_url: string;
  photo_url: string;
  twitter_url: string;
  email: string;
  email_status: string;
  city: string;
  country: string;
  seniority: string;
  organization_name: string;
  employment_history: ApolloEmployment[];
  organization: ApolloOrgFromReveal | null;
};

export type ApolloEmployment = {
  organization_name: string;
  title: string;
  current: boolean;
  start_date: string;
  end_date: string;
};

export type ApolloOrgFromReveal = {
  id: string;
  name: string;
  linkedin_url: string;
  primary_domain: string;
  website_url: string;
  short_description: string;
  industry: string;
  estimated_num_employees: number | null;
  founded_year: number | null;
  total_funding_printed: string;
  latest_funding_stage: string;
  phone: string;
  city: string;
  country: string;
  keywords: string[];
};

export type ApolloOrganisation = {
  id: string;
  name: string;
  domain: string;
  employee_count: number | null;
};

type PeopleSearchParams = {
  domain?: string;
  orgId?: string;
  organizationName?: string;
  personName?: string;
  personTitles?: string[];
  personSeniorities?: string[];
  personLocations?: string[];
  keywords?: string[];
  perPage?: number;
};

// ─── Domain Blocklist ───

const APOLLO_BASE = "https://api.apollo.io";

const BLOCKED_DOMAINS = new Set([
  "facebook.com", "meta.com", "amazon.com", "google.com", "apple.com",
  "twitter.com", "x.com", "instagram.com", "tiktok.com", "youtube.com",
  "linkedin.com", "indiegogo.com", "igg.me", "kickstarter.com",
  "backerkit.com", "gofundme.com", "shopify.com", "wordpress.com",
  "wix.com", "squarespace.com", "etsy.com", "ebay.com",
]);

export function isBlockedDomain(domain: string): boolean {
  if (!domain) return true;
  const cleaned = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (BLOCKED_DOMAINS.has(cleaned)) return true;
  for (const blocked of BLOCKED_DOMAINS) {
    if (cleaned.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

const shouldRetry = (error: unknown): boolean => {
  const axiosError = error as AxiosError;
  const status = axiosError.response?.status;
  if (status === 429) return true;
  return typeof status === "number" && status >= 500;
};

// ─── Search (FREE — returns metadata only, no reveal) ───

export async function searchPeopleMetadata(
  apiKey: string,
  params: PeopleSearchParams,
): Promise<ApolloSearchResult[]> {
  const body: Record<string, unknown> = {
    per_page: params.perPage ?? 5,
  };

  if (params.domain && !isBlockedDomain(params.domain)) {
    body.q_organization_domains = params.domain;
  }
  if (params.orgId) {
    body.organization_ids = [params.orgId];
  }
  if (params.organizationName) {
    body.q_organization_name = params.organizationName;
  }
  if (params.personName) {
    body.q_person_name = params.personName;
  }
  if (params.personTitles && params.personTitles.length > 0) {
    body.person_titles = params.personTitles;
  }
  if (params.personSeniorities && params.personSeniorities.length > 0) {
    body.person_seniorities = params.personSeniorities;
  }
  if (params.personLocations && params.personLocations.length > 0) {
    body.person_locations = params.personLocations;
  }
  if (params.keywords && params.keywords.length > 0) {
    body.q_keywords = params.keywords.join(" ");
  }

  try {
    const response = await withExponentialBackoff(
      () =>
        axios.post(`${APOLLO_BASE}/api/v1/mixed_people/api_search`, body, {
          headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
          timeout: 15_000,
        }),
      { retries: 3, initialDelayMs: 2000, maxDelayMs: 30_000, shouldRetry },
    );

    const people = (response.data?.people ?? []) as Array<Record<string, unknown>>;

    return people.map((p) => ({
      id: String(p.id ?? ""),
      first_name: String(p.first_name ?? ""),
      title: String(p.title ?? ""),
      organization_name: String((p.organization as Record<string, unknown>)?.name ?? ""),
      has_email: Boolean((p as Record<string, unknown>).has_email),
    }));
  } catch (error) {
    const axiosError = error as AxiosError;
    const responseData = axiosError.response?.data as Record<string, unknown> | undefined;
    logger.error(`[apollo] Search failed (${axiosError.response?.status ?? "unknown"}): ${responseData?.error ?? axiosError.message}`);
    return [];
  }
}

// ─── Reveal (PAID — 1 credit per person) ───

export async function revealByLinkedIn(
  apiKey: string,
  linkedinUrl: string,
): Promise<ApolloPerson | null> {
  try {
    const response = await withExponentialBackoff(
      () =>
        axios.post(
          `${APOLLO_BASE}/api/v1/people/match`,
          { linkedin_url: linkedinUrl, reveal_personal_emails: false },
          {
            headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
            timeout: 15_000,
          },
        ),
      { retries: 2, initialDelayMs: 1000, maxDelayMs: 10_000, shouldRetry },
    );

    const p = response.data?.person as Record<string, unknown> | undefined;
    if (!p?.id) return null;

    return parseRevealedPerson(p);
  } catch (error) {
    const axiosError = error as AxiosError;
    logger.warn(`[apollo] Reveal by LinkedIn failed for ${linkedinUrl}: ${axiosError.message} (${axiosError.response?.status ?? "unknown"})`);
    return null;
  }
}

export async function revealPerson(
  apiKey: string,
  personId: string,
): Promise<ApolloPerson | null> {
  try {
    const response = await withExponentialBackoff(
      () =>
        axios.post(
          `${APOLLO_BASE}/api/v1/people/match`,
          { id: personId, reveal_personal_emails: false },
          {
            headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
            timeout: 15_000,
          },
        ),
      { retries: 2, initialDelayMs: 1000, maxDelayMs: 10_000, shouldRetry },
    );

    const p = response.data?.person as Record<string, unknown> | undefined;
    if (!p?.id) return null;

    return parseRevealedPerson(p);
  } catch (error) {
    const axiosError = error as AxiosError;
    logger.warn(`[apollo] Reveal failed for ${personId}: ${axiosError.message} (${axiosError.response?.status ?? "unknown"})`);
    return null;
  }
}

// ─── Org Enrichment (PAID — 1 credit) ───

export async function searchOrganisation(
  apiKey: string,
  params: { domain?: string; name?: string },
): Promise<ApolloOrganisation | null> {
  const body: Record<string, unknown> = {};
  if (params.domain) body.domain = params.domain;
  if (params.name) body.name = params.name;

  try {
    const response = await withExponentialBackoff(
      () =>
        axios.post(`${APOLLO_BASE}/api/v1/organizations/enrich`, body, {
          headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
          timeout: 15_000,
        }),
      { retries: 3, initialDelayMs: 2000, maxDelayMs: 30_000, shouldRetry },
    );

    const org = response.data?.organization as Record<string, unknown> | undefined;
    if (!org?.id) return null;

    return {
      id: String(org.id),
      name: String(org.name ?? ""),
      domain: String(org.primary_domain ?? org.domain ?? ""),
      employee_count: typeof org.estimated_num_employees === "number" ? org.estimated_num_employees : null,
    };
  } catch (error) {
    const axiosError = error as AxiosError;
    logger.error(`[apollo] Org search failed: ${axiosError.message} (status ${axiosError.response?.status ?? "unknown"})`);
    return null;
  }
}

// ─── Parsers ───

function parseOrgFromReveal(raw: Record<string, unknown> | undefined): ApolloOrgFromReveal | null {
  if (!raw?.id) return null;
  return {
    id: String(raw.id), name: String(raw.name ?? ""),
    linkedin_url: String(raw.linkedin_url ?? ""),
    primary_domain: String(raw.primary_domain ?? ""),
    website_url: String(raw.website_url ?? ""),
    short_description: String(raw.short_description ?? ""),
    industry: Array.isArray(raw.industries) && raw.industries.length > 0 ? String(raw.industries[0]) : String(raw.industry ?? ""),
    estimated_num_employees: typeof raw.estimated_num_employees === "number" ? raw.estimated_num_employees : null,
    founded_year: typeof raw.founded_year === "number" ? raw.founded_year : null,
    total_funding_printed: String(raw.total_funding_printed ?? ""),
    latest_funding_stage: String(raw.latest_funding_stage ?? ""),
    phone: String(raw.phone ?? ""),
    city: String(raw.city ?? ""), country: String(raw.country ?? ""),
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map(String).slice(0, 20) : [],
  };
}

function parseRevealedPerson(p: Record<string, unknown>): ApolloPerson {
  return {
    id: String(p.id ?? ""), first_name: String(p.first_name ?? ""),
    last_name: String(p.last_name ?? ""), name: String(p.name ?? ""),
    title: String(p.title ?? ""), headline: String(p.headline ?? ""),
    linkedin_url: String(p.linkedin_url ?? ""),
    photo_url: String(p.photo_url ?? ""),
    twitter_url: String(p.twitter_url ?? ""),
    email: String(p.email ?? ""), email_status: String(p.email_status ?? ""),
    city: String(p.city ?? ""), country: String(p.country ?? ""),
    seniority: String(p.seniority ?? ""),
    organization_name: (p.organization as Record<string, unknown>)?.name
      ? String((p.organization as Record<string, unknown>).name) : "",
    employment_history: parseEmploymentHistory(p.employment_history),
    organization: parseOrgFromReveal(p.organization as Record<string, unknown> | undefined),
  };
}

function parseEmploymentHistory(raw: unknown): ApolloEmployment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((e: Record<string, unknown>) => ({
    organization_name: String(e.organization_name ?? ""),
    title: String(e.title ?? ""),
    current: Boolean(e.current),
    start_date: String(e.start_date ?? ""),
    end_date: String(e.end_date ?? ""),
  }));
}
