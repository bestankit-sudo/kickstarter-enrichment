import { CompanyDb } from "../notion/company-db.js";
import { KickstarterDb } from "../notion/kickstarter-db.js";
import { PeopleDb } from "../notion/people-db.js";
import { ExtractionDb } from "../notion/extraction-db.js";
import type { PeopleUpsertInput } from "../notion/people-db.js";
import {
  searchPeopleMetadata,
  revealPerson,
  searchOrganisation,
  isBlockedDomain,
  type ApolloPerson,
  type ApolloSearchResult,
} from "./apollo-client.js";
import { findLinkedInProfiles } from "./brave-search-client.js";
import {
  normalizeFounderNames,
  preliminaryScoreCandidates,
  scoreCandidates,
  validateCandidate,
  validateDataQuality,
  detectRebrand,
  generateOutreachBrief,
  generateCompanySummary,
  decideMerge,
  computeOutreachReadiness,
  type NormalizedFounder,
  type ScoredCandidate,
} from "../lib/ai-normalizer.js";
import { bestCompanyOutreachPath } from "../lib/decision-engine.js";
import {
  FOUNDER_TITLES,
  FOUNDER_SENIORITY,
  OPERATOR_TITLES,
  ALL_TITLES,
} from "../lib/role-priority.js";
import { logger } from "../utils/logger.js";
import type {
  CompanyRow,
  DiscoveryMethod,
  MatchConfidence,
  PeopleEnrichStatus,
} from "../notion/types.js";

type EnrichPeopleOptions = {
  companyDb: CompanyDb;
  peopleDb: PeopleDb;
  extractionDb: ExtractionDb;
  kickstarterDb: KickstarterDb;
  apolloApiKey: string;
  braveSearchApiKey: string;
  openaiApiKey: string;
  force: boolean;
  dryRun: boolean;
  limit?: number;
  kickstarterUrl?: string;
};

function hasHighConfidence(candidates: ScoredCandidate[]): boolean {
  return candidates.some((c) => c.confidence === "high");
}

function hasUsableCandidates(candidates: ScoredCandidate[]): boolean {
  return candidates.some((c) => c.confidence === "high" || c.confidence === "medium");
}

function deduplicateSearchResults(results: ApolloSearchResult[]): ApolloSearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    if (!r.id || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

export async function enrichPeople(options: EnrichPeopleOptions): Promise<void> {
  const companies = await options.companyDb.listForPeopleEnrichment();
  const sourceCampaigns = await options.kickstarterDb.listCampaigns();
  const sourceMap = new Map(sourceCampaigns.map((item) => [item.campaignName, item]));

  const scoped = options.kickstarterUrl
    ? companies.filter((c) => c.campaignName.includes(options.kickstarterUrl!))
    : companies;
  const capped = options.limit ? scoped.slice(0, options.limit) : scoped;

  logger.info(`[enrich-people] Starting... ${capped.length} companies eligible.`);

  if (options.dryRun) {
    for (const company of capped) {
      logger.info(`[dry-run] ${company.campaignName} | domain=${company.companyDomain}`);
    }
    return;
  }

  let totalDone = 0;
  let totalReview = 0;
  let totalFailed = 0;

  for (let i = 0; i < capped.length; i += 1) {
    const company = capped[i];
    const source = sourceMap.get(company.campaignName);

    // #7: Stale guard — skip partial records enriched within 7 days
    if (!options.force) {
      const existingCompany = company;
      if (
        (existingCompany.status === "partial" || existingCompany.status === "needs_review") &&
        existingCompany.lastCheckedAt
      ) {
        const daysSince = (Date.now() - new Date(existingCompany.lastCheckedAt).getTime()) / 86400000;
        if (daysSince < 7) {
          logger.info(`[skip] ${company.campaignName} — ${existingCompany.status}, enriched ${daysSince.toFixed(0)}d ago`);
          continue;
        }
      }
    }

    try {
      const result = await discoverLinkedInTarget(company, source?.founderCreator || "", source?.pageId || "", options);

      if (result.primaryStatus === "done") totalDone += 1;
      else if (result.primaryStatus === "needs_review") totalReview += 1;
      else totalFailed += 1;

      logger.info(
        `[${String(i + 1).padStart(3)}/${capped.length}] ${company.campaignName} → ${result.primaryStatus} (${result.candidateCount} candidates, ${result.revealsUsed} reveals)`,
      );
    } catch (error) {
      totalFailed += 1;
      logger.error(
        `[${String(i + 1).padStart(3)}/${capped.length}] ${company.campaignName} → error: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }

  logger.info(`[enrich-people] Done. ${totalDone} done, ${totalReview} needs_review, ${totalFailed} failed.`);
}

async function discoverLinkedInTarget(
  companyRow: CompanyRow,
  founderRaw: string,
  sourceCampaignPageId: string,
  options: EnrichPeopleOptions,
): Promise<{ primaryStatus: PeopleEnrichStatus; candidateCount: number; revealsUsed: number }> {
  let revealsUsed = 0;

  // Step 1: Normalise founder names
  const founders = await normalizeFounderNames(options.openaiApiKey, founderRaw);
  const companyName = companyRow.companyName || companyRow.campaignName;
  const domain = companyRow.companyDomain && !isBlockedDomain(companyRow.companyDomain)
    ? companyRow.companyDomain : undefined;
  const founderFullName = founders.length > 0 ? founders[0].full_name : undefined;

  logger.info(`[search] company="${companyName}" domain="${domain || "NONE/BLOCKED"}" founder="${founderFullName || "unknown"}"`);

  // Step 2: Search (FREE) — collect metadata from all passes, deduplicate
  let searchResults: ApolloSearchResult[] = [];

  // Pass A1: Domain + founder name + founder titles
  if (domain) {
    const a1 = await searchPeopleMetadata(options.apolloApiKey, {
      domain, orgId: companyRow.apolloOrgId || undefined,
      personName: founderFullName, personTitles: FOUNDER_TITLES, personSeniorities: FOUNDER_SENIORITY,
    });
    searchResults = deduplicateSearchResults([...searchResults, ...a1]);
  }

  // Pass A2: Company name + founder name (no domain needed)
  if (searchResults.length === 0) {
    const a2 = await searchPeopleMetadata(options.apolloApiKey, {
      organizationName: companyName, personName: founderFullName,
      personTitles: FOUNDER_TITLES, personSeniorities: FOUNDER_SENIORITY,
    });
    searchResults = deduplicateSearchResults([...searchResults, ...a2]);
  }

  // Pass A3: Founder name + company as keyword
  if (searchResults.length === 0 && founderFullName) {
    const a3 = await searchPeopleMetadata(options.apolloApiKey, {
      personName: founderFullName, keywords: [companyName],
    });
    searchResults = deduplicateSearchResults([...searchResults, ...a3]);
  }

  // Step 3: Preliminary AI score on metadata — decide who to reveal
  let revealedCandidates: ApolloPerson[] = [];

  if (searchResults.length > 0) {
    const prelim = await preliminaryScoreCandidates(
      options.openaiApiKey, searchResults, companyName, founderFullName || "", 2,
    );

    const toReveal = prelim.filter((p) => p.worth_revealing);
    logger.info(`[prelim] ${searchResults.length} search results → ${toReveal.length} worth revealing`);

    for (const pick of toReveal) {
      const revealed = await revealPerson(options.apolloApiKey, pick.id);
      if (revealed) {
        revealsUsed += 1;
        logger.info(`[reveal] ${revealed.name} — ${revealed.title} — ${revealed.linkedin_url || "no LinkedIn"} — ${revealed.email || "no email"}`);
        revealedCandidates.push(revealed);
      }
    }

    for (const skip of prelim.filter((p) => !p.worth_revealing)) {
      logger.info(`[prelim-skip] ${skip.id}: ${skip.reason}`);
    }
  }

  // Step 4: AI validate revealed candidates
  const validated = await validateCandidates(revealedCandidates, companyRow, options.openaiApiKey);

  // Step 5: Score validated candidates
  let scored = await scoreCandidates(options.openaiApiKey, validated, founders, companyName);

  // #4: If Pass A found medium+ confidence, DON'T fall through to Pass B
  if (hasUsableCandidates(scored)) {
    // Good enough — skip Pass B entirely
  } else if (scored.length === 0 || scored.every((c) => c.confidence === "low")) {
    // Pass B: Operator titles only (no B2 broad search — #5 removed)
    const b1 = await searchPeopleMetadata(options.apolloApiKey, {
      domain, organizationName: domain ? undefined : companyName,
      orgId: companyRow.apolloOrgId || undefined, personTitles: OPERATOR_TITLES,
    });

    const newB1 = deduplicateSearchResults(b1).filter(
      (r) => !revealedCandidates.some((rc) => rc.id === r.id),
    );

    if (newB1.length > 0) {
      const prelimB = await preliminaryScoreCandidates(
        options.openaiApiKey, newB1, companyName, "", 2,
      );

      for (const pick of prelimB.filter((p) => p.worth_revealing)) {
        const revealed = await revealPerson(options.apolloApiKey, pick.id);
        if (revealed) {
          revealsUsed += 1;
          logger.info(`[reveal-b] ${revealed.name} — ${revealed.title}`);
          revealedCandidates.push(revealed);
        }
      }

      const validatedB = await validateCandidates(
        revealedCandidates.filter((r) => newB1.some((b) => b.id === r.id)),
        companyRow, options.openaiApiKey,
      );
      const allValidated = [...validated, ...validatedB];
      scored = await scoreCandidates(options.openaiApiKey, allValidated, founders, companyName);
    }
  }

  // Pass C: Apollo Org resolution
  if (!hasUsableCandidates(scored) && companyName) {
    const org = await searchOrganisation(options.apolloApiKey, { name: companyName, domain: domain || undefined });
    if (org) {
      logger.info(`[pass-c] Org resolved: ${org.name} (${org.domain})`);
      const orgSearch = await searchPeopleMetadata(options.apolloApiKey, { orgId: org.id, personTitles: ALL_TITLES });
      const newOrg = deduplicateSearchResults(orgSearch).filter(
        (r) => !revealedCandidates.some((rc) => rc.id === r.id),
      );

      if (newOrg.length > 0) {
        const prelimC = await preliminaryScoreCandidates(options.openaiApiKey, newOrg, companyName, founderFullName || "", 2);
        for (const pick of prelimC.filter((p) => p.worth_revealing)) {
          const revealed = await revealPerson(options.apolloApiKey, pick.id);
          if (revealed) {
            revealsUsed += 1;
            revealedCandidates.push(revealed);
          }
        }

        const allValidated = await validateCandidates(revealedCandidates, companyRow, options.openaiApiKey);
        scored = await scoreCandidates(options.openaiApiKey, allValidated, founders, companyName);
      }
    }
  }

  // Pass D: Brave Search SERP fallback
  let discoveryMethod: DiscoveryMethod = "apollo";
  if (!hasUsableCandidates(scored)) {
    logger.info(`[pass-d] Attempting Brave Search fallback for "${companyName}"`);
    const serpCandidates = await findLinkedInProfiles(options.braveSearchApiKey, companyName, founders);
    logger.info(`[pass-d] Brave Search returned ${serpCandidates.length} candidates`);

    if (serpCandidates.length > 0) {
      discoveryMethod = "serp_fallback";
      scored = serpCandidates.map((c, index) => ({
        apollo_person_id: "", linkedin_url: c.linkedinUrl,
        name: c.name, first_name: c.name.split(" ")[0] || "",
        last_name: c.name.split(" ").slice(1).join(" ") || "",
        title: "", headline: "", photo_url: "", email: "", email_status: "",
        city: "", country: "", twitter_url: "", seniority: "",
        confidence: "medium" as MatchConfidence, outreach_relevance: "other" as const,
        evidence_summary: `SERP fallback: ${c.query}`, rank: index + 1,
        validated: false, outreach_brief: "", apolloPerson: {} as ApolloPerson,
      }));
    }
  }

  // No candidates at all
  if (scored.length === 0) {
    await options.companyDb.updateRollup(companyRow.pageId, {
      bestPersonPageId: null,
      bestOutreachPath: bestCompanyOutreachPath(null, companyRow),
      primaryPersonConfidence: null,
      companyOutreachReadiness: computeOutreachReadiness([], companyRow),
    });
    return { primaryStatus: "failed", candidateCount: 0, revealsUsed };
  }

  // Determine primary candidate
  const highConfidenceCandidates = scored.filter((c) => c.confidence === "high");
  const singleHighConfidence = highConfidenceCandidates.length === 1 ? highConfidenceCandidates[0] : null;

  // Backfill company data from Apollo org response
  const firstOrgData = scored.find((c) => c.apolloPerson?.organization)?.apolloPerson?.organization;
  let apolloDomain = "";
  if (firstOrgData) {
    apolloDomain = firstOrgData.primary_domain || "";
    if (companyRow.companyDomain && apolloDomain && companyRow.companyDomain !== apolloDomain) {
      const rebrand = await detectRebrand(options.openaiApiKey, companyRow.companyDomain, apolloDomain, companyRow.campaignName, firstOrgData.name);
      if (rebrand.isRebrand) {
        logger.info(`[rebrand] Detected: ${companyRow.companyDomain} → ${apolloDomain} (${rebrand.explanation})`);
      }
    }
    const companySummary = await generateCompanySummary(options.openaiApiKey, firstOrgData, companyRow.campaignName);
    if (companySummary) firstOrgData.short_description = companySummary;
    await options.companyDb.backfillFromApolloOrg(companyRow.pageId, firstOrgData);
  }

  // Write candidates to People Enriched
  let primaryPersonPageId: string | null = null;

  for (const candidate of scored) {
    // Data quality gate
    const validDomains = [companyRow.companyDomain, apolloDomain].filter(Boolean).join(" or ");
    const quality = await validateDataQuality(options.openaiApiKey, candidate, companyRow.companyName || companyRow.campaignName, validDomains);
    if (!quality.pass) {
      logger.info(`[quality] Rejected: ${candidate.name} — ${quality.issues.join("; ")}`);
      continue;
    }

    const isPrimary = singleHighConfidence !== null && candidate.apollo_person_id === singleHighConfidence.apollo_person_id && candidate.rank === 1;

    // Merge decision for existing records
    const existing = candidate.apollo_person_id
      ? await options.peopleDb.findByApolloPersonId(candidate.apollo_person_id)
      : await options.peopleDb.findByFullName(candidate.name);

    if (existing) {
      const merge = await decideMerge(
        options.openaiApiKey,
        { fullName: existing.fullName, linkedinUrl: existing.linkedinPersonUrl, email: existing.workEmails, title: "", headline: existing.headline, city: existing.city, country: existing.country, confidence: existing.matchConfidence, evidenceSummary: existing.evidenceSummary },
        { fullName: candidate.name, linkedinUrl: candidate.linkedin_url, email: candidate.email, title: candidate.title, headline: candidate.headline, city: candidate.city, country: candidate.country, confidence: candidate.confidence, evidenceSummary: candidate.evidence_summary },
        companyRow.companyName || companyRow.campaignName,
      );
      if (merge.action === "skip") {
        logger.info(`[merge] Skipped: ${candidate.name} — ${merge.reason}`);
        continue;
      }
      if (merge.mergedFields.linkedinUrl && !candidate.linkedin_url) candidate.linkedin_url = merge.mergedFields.linkedinUrl;
      if (merge.mergedFields.email && !candidate.email) candidate.email = merge.mergedFields.email;
      logger.info(`[merge] Writing: ${candidate.name} — ${merge.reason}`);
    }

    let outreachBrief = "";
    if (isPrimary) {
      outreachBrief = await generateOutreachBrief(options.openaiApiKey, candidate, companyRow.campaignName, companyRow.companyName || companyRow.campaignName);
    }

    const personStatus = derivePersonStatus(candidate, singleHighConfidence);

    const { pageId } = await options.peopleDb.upsert(existing?.pageId ?? null, {
      fullName: candidate.name || "", firstName: candidate.first_name || "",
      lastName: candidate.last_name || "", headline: candidate.headline || "",
      companyPageId: companyRow.pageId, sourceCampaignPageId,
      city: candidate.city || "", country: candidate.country || "",
      jobTitle: candidate.title || "", linkedInPersonUrl: candidate.linkedin_url || "",
      apolloPersonId: candidate.apollo_person_id || "", twitterXUrl: candidate.twitter_url || "",
      discoveryMethod, candidateRank: candidate.rank, isPrimaryCandidate: isPrimary,
      evidenceSummary: candidate.evidence_summary,
      workEmails: candidate.email || null, emailStatus: candidate.email_status || "not_found",
      status: personStatus, matchConfidence: candidate.confidence,
      matchNotes: `${discoveryMethod} | ${candidate.evidence_summary}${outreachBrief ? ` | Outreach: ${outreachBrief}` : ""}`,
    });

    // Write extraction record
    await options.extractionDb.create({
      title: `${discoveryMethod === "serp_fallback" ? "SERP" : "Apollo"} reveal: ${candidate.name}`,
      type: "people",
      source: discoveryMethod === "serp_fallback" ? "brave_serp" : "apollo_reveal",
      status: personStatus === "failed" ? "rejected" : "accepted",
      rawData: JSON.stringify({
        apollo_person_id: candidate.apollo_person_id,
        linkedin_url: candidate.linkedin_url,
        email: candidate.email,
        email_status: candidate.email_status,
        title: candidate.title,
        headline: candidate.headline,
        confidence: candidate.confidence,
        outreach_relevance: candidate.outreach_relevance,
      }),
      sourceNotes: `${discoveryMethod} | ${candidate.evidence_summary}${outreachBrief ? ` | Outreach: ${outreachBrief}` : ""}`,
      aiValidation: candidate.evidence_summary,
      creditsUsed: candidate.apollo_person_id ? 1 : 0,
      personPageId: pageId,
      companyPageId: companyRow.pageId,
      campaignPageId: sourceCampaignPageId || undefined,
    });

    if (isPrimary) primaryPersonPageId = pageId;
  }

  // Company roll-up
  const primary = singleHighConfidence;
  const primaryInfo = primary ? { linkedinUrl: primary.linkedin_url, confidence: primary.confidence, workEmails: primary.email || "" } : null;
  await options.companyDb.updateRollup(companyRow.pageId, {
    bestPersonPageId: primaryPersonPageId,
    bestOutreachPath: bestCompanyOutreachPath(primaryInfo, companyRow),
    primaryPersonConfidence: primary?.confidence ?? null,
    companyOutreachReadiness: computeOutreachReadiness(scored, companyRow),
  });

  const primaryStatus: PeopleEnrichStatus = singleHighConfidence
    ? "done" : hasUsableCandidates(scored) ? scored.length > 1 ? "needs_review" : "partial" : "failed";

  return { primaryStatus, candidateCount: scored.length, revealsUsed };
}

async function validateCandidates(
  candidates: ApolloPerson[], companyRow: CompanyRow, openaiApiKey: string,
): Promise<ApolloPerson[]> {
  const validated: ApolloPerson[] = [];
  for (const person of candidates) {
    const result = await validateCandidate(openaiApiKey, person, companyRow.companyName || companyRow.campaignName, companyRow.companyDomain || "");
    if (result.valid) { validated.push(person); }
    else { logger.info(`[validation] Rejected: ${person.name} — ${result.reason}`); }
  }
  return validated;
}

function derivePersonStatus(candidate: ScoredCandidate, singleHighConfidence: ScoredCandidate | null): PeopleEnrichStatus {
  if (singleHighConfidence && candidate.apollo_person_id === singleHighConfidence.apollo_person_id) return "done";
  if (candidate.confidence === "medium") return "partial";
  return "needs_review";
}
