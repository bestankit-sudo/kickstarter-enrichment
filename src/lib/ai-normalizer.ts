import OpenAI from "openai";
import { parseFounderNames } from "../utils/name-parser.js";
import { logger } from "../utils/logger.js";
import type {
  CompanyOutreachReadiness,
  CompanyRow,
  MatchConfidence,
  OutreachRelevance,
} from "../notion/types.js";
import type { ApolloPerson, ApolloOrgFromReveal, ApolloSearchResult } from "../enrichment/apollo-client.js";

export type NormalizedFounder = {
  full_name: string;
  first_name: string;
  last_name: string;
};

export type ScoredCandidate = {
  apollo_person_id: string;
  linkedin_url: string;
  name: string;
  first_name: string;
  last_name: string;
  title: string;
  headline: string;
  photo_url: string;
  email: string;
  email_status: string;
  city: string;
  country: string;
  twitter_url: string;
  seniority: string;
  confidence: MatchConfidence;
  outreach_relevance: OutreachRelevance;
  evidence_summary: string;
  rank: number;
  validated: boolean;
  outreach_brief: string;
  apolloPerson: ApolloPerson;
};

const MODEL = "gpt-5.4";

function isValidLinkedInUrl(url: string): boolean {
  if (!url) return false;
  return /linkedin\.com\/in\//i.test(url);
}

// ─── 1. Founder Name Normalization ───

export async function normalizeFounderNames(
  apiKey: string,
  founderCreatorRaw: string,
): Promise<NormalizedFounder[]> {
  if (!founderCreatorRaw.trim()) return [];

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 500,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: `You will receive a raw Founder / Creator string from a Kickstarter campaign record.
1. If multiple people are listed (e.g. "Alex & Jamie", "Sarah and Tom"), split them into separate name entries.
2. Strip any role labels, noise words, or qualifiers (e.g. "founded by", "(CEO)", "creator:").
3. For each person, return first_name and last_name. If last name cannot be determined, return what is available.
4. If the input looks like a company name (not a person), return an empty array.
5. Return a JSON array only. No preamble.

Format: [{ "full_name": "", "first_name": "", "last_name": "" }]

Input: ${founderCreatorRaw}`,
        },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array found");
    const parsed = JSON.parse(jsonMatch[0]) as NormalizedFounder[];
    if (!Array.isArray(parsed)) throw new Error("Not an array");
    return parsed.filter((p) => p.first_name);
  } catch (error) {
    logger.warn(`[ai] Founder name normalization failed, falling back to regex: ${error instanceof Error ? error.message : "unknown"}`);
    const regexParsed = parseFounderNames(founderCreatorRaw);
    return regexParsed.map((p) => ({
      full_name: [p.firstName, p.lastName].filter(Boolean).join(" "),
      first_name: p.firstName,
      last_name: p.lastName,
    }));
  }
}

// ─── 1b. Preliminary Score (on search metadata BEFORE reveal) ───

export type PreliminaryScore = {
  id: string;
  worth_revealing: boolean;
  reason: string;
};

export async function preliminaryScoreCandidates(
  apiKey: string,
  candidates: ApolloSearchResult[],
  targetCompanyName: string,
  founderName: string,
  maxReveals: number = 2,
): Promise<PreliminaryScore[]> {
  if (candidates.length === 0) return [];

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 400,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: `I searched Apollo for people at "${targetCompanyName}" (expected founder: "${founderName || "unknown"}").

Apollo returned these candidates (metadata only — no LinkedIn URLs or emails yet, those cost 1 credit each to reveal):

${candidates.map((c, i) => `${i + 1}. ID: ${c.id} | Name: ${c.first_name} | Title: ${c.title} | Org: ${c.organization_name}`).join("\n")}

Which candidates are worth paying to reveal? Pick at most ${maxReveals}. Consider:
- Does the org name match or relate to "${targetCompanyName}"?
- Is the title relevant (founder, CEO, partnerships, marketing)?
- Does the first name match the expected founder?

Reply JSON ONLY — array of ALL candidates:
[{ "id": "", "worth_revealing": true/false, "reason": "one sentence" }]`,
        },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array");

    const parsed = JSON.parse(jsonMatch[0]) as PreliminaryScore[];
    return parsed;
  } catch (error) {
    logger.warn(`[ai] Preliminary scoring failed: ${error instanceof Error ? error.message : "unknown"}`);
    // Fallback: reveal top 2 by default
    return candidates.slice(0, maxReveals).map((c) => ({
      id: c.id, worth_revealing: true, reason: "AI scoring failed — revealing top candidates",
    }));
  }
}

// ─── 2. Candidate Validation (works at target company?) ───

export async function validateCandidate(
  apiKey: string,
  person: ApolloPerson,
  targetCompanyName: string,
  targetDomain: string,
): Promise<{ valid: boolean; reason: string }> {
  if (!person.name && !person.first_name) {
    return { valid: false, reason: "No name returned by Apollo" };
  }
  if (person.linkedin_url && !isValidLinkedInUrl(person.linkedin_url)) {
    return { valid: false, reason: `Invalid LinkedIn URL: ${person.linkedin_url}` };
  }

  const currentJobs = person.employment_history
    .filter((e) => e.current)
    .map((e) => `${e.title} at ${e.organization_name}`)
    .join("; ");

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 200,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: `Does this person currently work at or have a clear connection to the target company?

Target company: "${targetCompanyName}" (domain: ${targetDomain})
Person: ${person.name} — ${person.title}
Current employer from Apollo: ${person.organization_name}
Employment history (current roles): ${currentJobs || "none listed"}
Person's email domain: ${person.email?.split("@")[1] || "unknown"}

Reply ONLY with JSON: { "valid": true/false, "reason": "one sentence" }
- valid=true ONLY if they currently work at the target company or a clearly related entity (subsidiary, rebrand, parent)
- valid=false if they work at an unrelated company, even if the name sounds similar`,
        },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { valid: true, reason: "AI validation inconclusive" };
    const parsed = JSON.parse(jsonMatch[0]) as { valid: boolean; reason: string };
    return { valid: Boolean(parsed.valid), reason: String(parsed.reason ?? "") };
  } catch {
    return { valid: true, reason: "AI validation failed — allowing" };
  }
}

// ─── 3. Candidate Scoring + Evidence Summary ───

export async function scoreCandidates(
  apiKey: string,
  candidates: ApolloPerson[],
  founderNames: NormalizedFounder[],
  companyName: string,
): Promise<ScoredCandidate[]> {
  if (candidates.length === 0) return [];

  const founderNameStr = founderNames.map((f) => f.full_name).join(", ") || "unknown";

  const scoringInput = candidates.map((c) => ({
    id: c.id,
    name: c.name,
    title: c.title,
    headline: c.headline,
    linkedin_url: c.linkedin_url,
    email: c.email,
    organization_name: c.organization_name,
    seniority: c.seniority,
    country: c.country,
    current_employer: c.employment_history.filter((e) => e.current).map((e) => `${e.title} at ${e.organization_name}`).join("; "),
  }));

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 1500,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: `Score these Apollo search results for outreach to company "${companyName}".
Expected founder: ${founderNameStr}.

Scoring rules:
- HIGH: Person is the founder/co-founder/CEO of "${companyName}" with confirmed name match or clear company match. Has LinkedIn URL.
- MEDIUM: Person works at "${companyName}" in a collaboration-relevant role (partnerships, marketing, BD). Has LinkedIn URL.
- LOW: Weak match — no LinkedIn URL, or person's connection to "${companyName}" is unclear.

For each candidate provide:
- confidence: high / medium / low
- outreach_relevance: founder / co_founder / ceo / partnerships / marketing / other
- evidence_summary: 1-2 precise sentences. Include the person's ACTUAL current employer, their role, and WHY they are or aren't a good match. Be specific — name the company they work at. Don't be vague.

Return a ranked JSON array ONLY. No preamble.
Format: [{ "apollo_person_id": "", "confidence": "", "outreach_relevance": "", "evidence_summary": "", "rank": 1 }]

Candidates:
${JSON.stringify(scoringInput, null, 2)}`,
        },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array found");

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      apollo_person_id?: string;
      confidence?: string;
      outreach_relevance?: string;
      evidence_summary?: string;
      rank?: number;
    }>;

    return parsed.map((item, index) => {
      const mp = candidates.find((c) => c.id === item.apollo_person_id);
      if (!mp) return buildFallbackScored(candidates[index] ?? candidates[0], index + 1);
      return {
        apollo_person_id: item.apollo_person_id ?? "",
        linkedin_url: mp.linkedin_url,
        name: mp.name,
        first_name: mp.first_name,
        last_name: mp.last_name,
        title: mp.title,
        headline: mp.headline,
        photo_url: mp.photo_url,
        email: mp.email,
        email_status: mp.email_status,
        city: mp.city,
        country: mp.country,
        twitter_url: mp.twitter_url,
        seniority: mp.seniority,
        confidence: (item.confidence ?? "low") as MatchConfidence,
        outreach_relevance: (item.outreach_relevance ?? "other") as OutreachRelevance,
        evidence_summary: item.evidence_summary ?? "",
        rank: item.rank ?? index + 1,
        validated: true,
        outreach_brief: "",
        apolloPerson: mp,
      };
    });
  } catch (error) {
    logger.warn(`[ai] Candidate scoring failed: ${error instanceof Error ? error.message : "unknown"}`);
    return candidates.map((c, i) => buildFallbackScored(c, i + 1));
  }
}

// ─── 4. Data Quality Gate ───

export async function validateDataQuality(
  apiKey: string,
  person: ScoredCandidate,
  targetCompanyName: string,
  targetDomain: string,
): Promise<{ pass: boolean; issues: string[] }> {
  const issues: string[] = [];

  // Structural checks first (no AI needed)
  if (person.linkedin_url && !isValidLinkedInUrl(person.linkedin_url)) {
    issues.push(`Invalid LinkedIn URL: ${person.linkedin_url}`);
  }
  if (person.email && person.email_status !== "verified" && person.email_status !== "valid") {
    // Email exists but not verified — flag but don't reject
  }
  if (!person.name || person.name === "Not Found") {
    issues.push("No name resolved");
  }

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 300,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: `Review this person record for data quality before saving to our CRM.
Target company: "${targetCompanyName}" (domain: ${targetDomain})

Person: ${person.name}
Title: ${person.title}
Headline: ${person.headline}
LinkedIn: ${person.linkedin_url || "none"}
Email: ${person.email || "none"} (status: ${person.email_status})
Email domain: ${person.email?.split("@")[1] || "none"}
Company from Apollo: ${person.apolloPerson?.organization_name || "unknown"}

Check and return JSON ONLY:
{
  "pass": true/false,
  "issues": ["list of specific issues found"]
}

ONLY reject (pass=false) if:
- Person appears to be a bot, mascot, or placeholder
- Person is clearly at the WRONG company (not a subsidiary, rebrand, or related entity)
- LinkedIn URL is invalid or not a person profile
- Name is missing or fake

DO pass (pass=true) even if:
- Email is missing (LinkedIn-only contacts are acceptable for outreach)
- Email domain doesn't match (person may use personal email)
- Title or headline is missing
- Company from Apollo is unknown (expected for SERP-sourced candidates)
Pass if the person looks like a real human who could plausibly be associated with the target company.`,
        },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { pass: boolean; issues: string[] };
      issues.push(...(parsed.issues || []));
      return { pass: parsed.pass !== false, issues };
    }
  } catch {
    // AI check failed — pass with structural issues only
  }

  return { pass: issues.length === 0, issues };
}

// ─── 5. Company Rebrand Detection ───

export async function detectRebrand(
  apiKey: string,
  externalLinkDomain: string,
  apolloDomain: string,
  campaignName: string,
  apolloOrgName: string,
): Promise<{ isRebrand: boolean; explanation: string }> {
  if (!externalLinkDomain || !apolloDomain) return { isRebrand: false, explanation: "Missing domain" };
  if (externalLinkDomain === apolloDomain) return { isRebrand: false, explanation: "Domains match" };

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 150,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: `Are these the same company (rebrand/domain change) or different companies?

Kickstarter campaign: "${campaignName}"
External link domain: ${externalLinkDomain}
Apollo found domain: ${apolloDomain}
Apollo org name: "${apolloOrgName}"

Reply JSON ONLY: { "isRebrand": true/false, "explanation": "one sentence" }`,
        },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { isRebrand: boolean; explanation: string };
      return { isRebrand: Boolean(parsed.isRebrand), explanation: String(parsed.explanation ?? "") };
    }
  } catch { /* fall through */ }

  return { isRebrand: false, explanation: "Could not determine" };
}

// ─── 6. Outreach Brief ───

export async function generateOutreachBrief(
  apiKey: string,
  person: ScoredCandidate,
  campaignName: string,
  companyName: string,
): Promise<string> {
  try {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 150,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content: `Write a 1-2 sentence outreach talking point for reaching out to this person about a collaboration opportunity.

Person: ${person.name}, ${person.title} at ${companyName}
Their LinkedIn headline: ${person.headline || "N/A"}
Kickstarter campaign: "${campaignName}"
Their role relevance: ${person.outreach_relevance}

The outreach is about podcast/content collaboration related to their Kickstarter product. Be specific to their product and role. No greetings or sign-offs — just the talking point.`,
        },
      ],
    });

    return response.choices[0]?.message?.content?.trim() ?? "";
  } catch {
    return "";
  }
}

// ─── 7. Company Intelligence Summary ───

export async function generateCompanySummary(
  apiKey: string,
  org: ApolloOrgFromReveal,
  campaignName: string,
): Promise<string> {
  try {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 200,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: `Write a concise 2-3 sentence company intelligence summary for outreach purposes.

Company: ${org.name}
Industry: ${org.industry}
Domain: ${org.primary_domain}
Employees: ${org.estimated_num_employees ?? "unknown"}
Founded: ${org.founded_year ?? "unknown"}
Funding: ${org.total_funding_printed || "unknown"} (${org.latest_funding_stage || "unknown stage"})
Location: ${[org.city, org.country].filter(Boolean).join(", ") || "unknown"}
Description: ${org.short_description || "N/A"}
Kickstarter campaign: "${campaignName}"

Focus on: what the company does, their stage/size, and why they'd be relevant for a collaboration outreach. Be factual and specific.`,
        },
      ],
    });

    return response.choices[0]?.message?.content?.trim() ?? "";
  } catch {
    return "";
  }
}

// ─── Outreach Readiness (deterministic, no AI) ───

export function computeOutreachReadiness(
  scoredCandidates: ScoredCandidate[],
  companyRow: CompanyRow,
): CompanyOutreachReadiness {
  const highConfidencePrimary = scoredCandidates.find(
    (c) => c.confidence === "high" && c.rank === 1 && c.linkedin_url,
  );
  if (highConfidencePrimary) return "ready_person";

  const hasCompanyChannel =
    companyRow.genericBusinessEmail || companyRow.instagramUrl || companyRow.tiktokUrl ||
    companyRow.contactFormUrl || companyRow.xUrl || companyRow.facebookUrl;
  if (hasCompanyChannel) return "ready_company_channel";

  if (scoredCandidates.some((c) => c.confidence === "medium")) return "review";

  return "blocked";
}

// ─── 8. Merge Decision (existing vs new data) ───

export type MergeDecision = {
  action: "write" | "skip";
  reason: string;
  mergedFields: Record<string, string>;
};

export async function decideMerge(
  apiKey: string,
  existing: {
    fullName: string;
    linkedinUrl: string;
    email: string;
    title: string;
    headline: string;
    city: string;
    country: string;
    confidence: string;
    evidenceSummary: string;
  },
  incoming: {
    fullName: string;
    linkedinUrl: string;
    email: string;
    title: string;
    headline: string;
    city: string;
    country: string;
    confidence: string;
    evidenceSummary: string;
  },
  companyName: string,
): Promise<MergeDecision> {
  // Quick structural check: if existing has no real data, always write
  const existingHasData = existing.fullName && existing.fullName !== "Not Found" && existing.fullName !== "Unknown";
  if (!existingHasData) {
    return { action: "write", reason: "Existing record has no name — incoming is an improvement", mergedFields: {} };
  }

  // If incoming has no real data, skip
  const incomingHasData = incoming.fullName && incoming.fullName !== "Not Found" && incoming.fullName !== "Unknown";
  if (!incomingHasData) {
    return { action: "skip", reason: "Incoming has no name — keeping existing", mergedFields: {} };
  }

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 400,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: `Compare existing vs incoming person data for company "${companyName}". Decide what to do.

EXISTING record in database:
- Name: ${existing.fullName}
- LinkedIn: ${existing.linkedinUrl || "none"}
- Email: ${existing.email || "none"}
- Title: ${existing.title || "none"}
- Headline: ${existing.headline || "none"}
- City: ${existing.city || "none"}
- Country: ${existing.country || "none"}
- Confidence: ${existing.confidence}
- Evidence: ${existing.evidenceSummary}

INCOMING new data:
- Name: ${incoming.fullName}
- LinkedIn: ${incoming.linkedinUrl || "none"}
- Email: ${incoming.email || "none"}
- Title: ${incoming.title || "none"}
- Headline: ${incoming.headline || "none"}
- City: ${incoming.city || "none"}
- Country: ${incoming.country || "none"}
- Confidence: ${incoming.confidence}
- Evidence: ${incoming.evidenceSummary}

Rules:
1. If they're the SAME person (same name or same LinkedIn) → "write" with merged best-of-both data
2. If incoming is a DIFFERENT, BETTER person (higher confidence, more data) → "write"
3. If incoming is a DIFFERENT, WORSE person → "skip"
4. If it's a DUPLICATE with no new information → "skip"
5. Always prefer records with LinkedIn URLs and verified emails

Reply JSON ONLY:
{
  "action": "write" or "skip",
  "reason": "one sentence",
  "mergedFields": { field: "best value to use" } (only for fields where existing has better data than incoming)
}`,
        },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as MergeDecision;
      return {
        action: parsed.action === "skip" ? "skip" : "write",
        reason: String(parsed.reason ?? ""),
        mergedFields: parsed.mergedFields ?? {},
      };
    }
  } catch {
    // AI failed — default to write if incoming has more data
  }

  return { action: "write", reason: "AI merge decision failed — defaulting to write", mergedFields: {} };
}

// ─── Helper ───

function buildFallbackScored(c: ApolloPerson, rank: number): ScoredCandidate {
  return {
    apollo_person_id: c.id, linkedin_url: c.linkedin_url, name: c.name,
    first_name: c.first_name, last_name: c.last_name, title: c.title,
    headline: c.headline, photo_url: c.photo_url, email: c.email,
    email_status: c.email_status, city: c.city, country: c.country,
    twitter_url: c.twitter_url, seniority: c.seniority,
    confidence: "low", outreach_relevance: "other",
    evidence_summary: "AI scoring failed — manual review recommended",
    rank, validated: false, outreach_brief: "", apolloPerson: c,
  };
}
