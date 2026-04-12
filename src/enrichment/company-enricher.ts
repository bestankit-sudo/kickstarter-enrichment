import { CompanyDb } from "../notion/company-db.js";
import { KickstarterDb } from "../notion/kickstarter-db.js";
import { searchOrganisation } from "./apollo-client.js";
import { scrapeWebsite } from "./website-scraper.js";
import { extractDomain } from "../utils/url.js";
import { logger } from "../utils/logger.js";
import type { EnrichmentStatus, MatchConfidence } from "../notion/types.js";

const shouldSkipStatus = (status: EnrichmentStatus, force: boolean): boolean => {
  if (status === "needs_review") {
    return true;
  }
  if (status === "done" && !force) {
    return true;
  }
  return false;
};

const deriveStatusAndConfidence = (input: {
  fetched: boolean;
  socialCount: number;
  hasEmail: boolean;
}): { status: EnrichmentStatus; confidence: MatchConfidence } => {
  if (!input.fetched) {
    return { status: "failed", confidence: "low" };
  }

  if (input.socialCount > 0 || input.hasEmail) {
    const confidence: MatchConfidence =
      input.socialCount >= 3 ? "high" : input.socialCount >= 1 ? "medium" : "low";
    return { status: "done", confidence };
  }

  return { status: "partial", confidence: "low" };
};

export async function enrichCompanies(options: {
  kickstarterDb: KickstarterDb;
  companyDb: CompanyDb;
  apolloApiKey: string;
  force: boolean;
  dryRun: boolean;
  limit?: number;
  kickstarterUrl?: string;
}): Promise<void> {
  const all = await options.kickstarterDb.listCampaigns();
  const scoped = options.kickstarterUrl
    ? all.filter((campaign) => campaign.kickstarterUrlRaw === options.kickstarterUrl)
    : all;

  const capped = options.limit ? scoped.slice(0, options.limit) : scoped;
  let alreadyDone = 0;
  const plans: Array<(typeof capped)[number]> = [];

  for (const campaign of capped) {
    const existing = await options.companyDb.findByCampaignName(campaign.campaignName);
    if (existing && shouldSkipStatus(existing.status, options.force)) {
      alreadyDone += 1;
      continue;
    }
    plans.push(campaign);
  }

  logger.info(
    `[enrich-companies] Starting... ${capped.length} campaigns found, ${alreadyDone} already done, ${plans.length} to process.`,
  );
  logger.info(`[enrich-companies] Estimated: ${plans.length} website fetches, 0 API credits.`);

  if (options.dryRun) {
    logger.info("[enrich-companies] Dry run enabled: skipping website fetch + Notion writes.");
    return;
  }

  let done = 0;
  let partial = 0;
  let needsReview = 0;
  let failed = 0;

  for (let i = 0; i < plans.length; i += 1) {
    const campaign = plans[i];
    const existing = await options.companyDb.findByCampaignName(campaign.campaignName);

    const companyDomain = extractDomain(campaign.externalLink || "");
    if (!companyDomain) {
      needsReview += 1;
      await options.companyDb.upsert(existing?.pageId ?? null, {
        campaignName: campaign.campaignName,
        sourceCampaignPageId: campaign.pageId,
        externalLink: campaign.externalLink,
        companyDomain: "",
        companyCountry: "",
        socials: { linkedin: null, x: null, instagram: null, facebook: null, youtube: null, tiktok: null },
        genericBusinessEmail: null,
        status: "needs_review",
        matchConfidence: "low",
        sourceNotes: "No valid External Link",
      });

      // Apollo Org exception: domain missing but campaign name exists
      if (campaign.campaignName) {
        const org = await searchOrganisation(options.apolloApiKey, {
          name: campaign.campaignName,
        });
        if (org) {
          const refetched = await options.companyDb.findByCampaignName(campaign.campaignName);
          if (refetched) {
            await options.companyDb.upsert(refetched.pageId, {
              campaignName: campaign.campaignName,
              sourceCampaignPageId: campaign.pageId,
              externalLink: campaign.externalLink,
              companyDomain: org.domain || "",
              socials: { linkedin: null, x: null, instagram: null, facebook: null, youtube: null, tiktok: null },
              genericBusinessEmail: null,
              apolloOrgId: org.id,
              employeeCount: org.employee_count,
              status: org.domain ? "partial" : "needs_review",
              matchConfidence: org.domain ? "medium" : "low",
              sourceNotes: `Apollo Org resolved: ${org.name} (${org.domain || "no domain"})`,
              sourcesUsed: "apollo_org",
            });
            logger.info(`[${String(i + 1).padStart(3)}/${plans.length}] ⚡ ${campaign.campaignName} -> Apollo Org resolved (${org.domain || "no domain"})`);
          }
        }
      }

      logger.warn(`[${String(i + 1).padStart(3)}/${plans.length}] ⊘ ${campaign.campaignName} -> needs_review (no External Link)`);
      continue;
    }

    const scrape = await scrapeWebsite(campaign.externalLink);
    const socialCount = Object.values(scrape.socials).filter(Boolean).length;
    const summary = deriveStatusAndConfidence({
      fetched: scrape.fetched,
      socialCount,
      hasEmail: Boolean(scrape.businessEmail),
    });

    let sourcesUsed = "website_scrape";

    await options.companyDb.upsert(existing?.pageId ?? null, {
      campaignName: campaign.campaignName,
      sourceCampaignPageId: campaign.pageId,
      externalLink: campaign.externalLink,
      companyDomain,
      companyCountry: "",
      socials: scrape.socials,
      genericBusinessEmail: scrape.businessEmail,
      status: summary.status,
      matchConfidence: summary.confidence,
      sourceNotes: scrape.sourceNotes,
      sourcesUsed,
    });

    // Apollo Org exception: scrape failed and campaign is promising
    if (summary.status === "failed" && campaign.campaignName) {
      const org = await searchOrganisation(options.apolloApiKey, {
        name: campaign.campaignName,
        domain: companyDomain,
      });
      if (org) {
        const refetched = await options.companyDb.findByCampaignName(campaign.campaignName);
        if (refetched) {
          sourcesUsed = "website_scrape|apollo_org";
          await options.companyDb.upsert(refetched.pageId, {
            campaignName: campaign.campaignName,
            sourceCampaignPageId: campaign.pageId,
                  externalLink: campaign.externalLink,
            companyDomain: org.domain || companyDomain,
            socials: scrape.socials,
            genericBusinessEmail: scrape.businessEmail,
            apolloOrgId: org.id,
            employeeCount: org.employee_count,
            status: "partial",
            matchConfidence: "medium",
            sourceNotes: `Website failed; Apollo Org resolved: ${org.name}`,
            sourcesUsed,
          });
          logger.info(`[${String(i + 1).padStart(3)}/${plans.length}] ⚡ ${campaign.campaignName} -> Apollo Org fallback (${org.domain || "no domain"})`);
        }
      }
    }

    if (summary.status === "done") {
      done += 1;
      logger.info(
        `[${String(i + 1).padStart(3)}/${plans.length}] ✓ ${campaign.campaignName} -> done (${socialCount} socials, ${scrape.businessEmail ? 1 : 0} email)`,
      );
    } else if (summary.status === "partial") {
      partial += 1;
      logger.warn(`[${String(i + 1).padStart(3)}/${plans.length}] ✓ ${campaign.campaignName} -> partial (no socials found)`);
    } else {
      failed += 1;
      logger.error(
        `[${String(i + 1).padStart(3)}/${plans.length}] ✗ ${campaign.campaignName} -> failed (${scrape.sourceNotes || "website fetch failed"})`,
      );
    }
  }

  logger.info(`[enrich-companies] Done. ${done} done, ${partial} partial, ${needsReview} needs_review, ${failed} failed.`);
}
