import { CompanyDb } from "../notion/company-db.js";
import { KickstarterDb } from "../notion/kickstarter-db.js";
import { PeopleDb } from "../notion/people-db.js";
import { findPersonByRole } from "./proxycurl.js";
import { parseFounderNames } from "../utils/name-parser.js";
import { logger } from "../utils/logger.js";
import type { PersonRoleTarget } from "../notion/types.js";

const NOT_FOUND = "Not Found";

const PROXY_ROLE_TARGET: Record<PersonRoleTarget, "CEO_FOUNDER" | "CTO" | "COO_CMO"> = {
  Founder: "CEO_FOUNDER",
  "Co-Founder": "CEO_FOUNDER",
  "C Level executive": "COO_CMO",
  "Director level executive": "CTO",
};

type PlannedRole = {
  roleTarget: PersonRoleTarget;
  firstName: string;
  lastName: string;
  keySuffix: string;
};

const NON_FOUNDER_ROLES: PersonRoleTarget[] = ["C Level executive", "Director level executive"];

const buildPlannedRoles = (founderRaw: string): PlannedRole[] => {
  const founders = parseFounderNames(founderRaw);
  const planned: PlannedRole[] = [];

  if (founders.length === 0) {
    planned.push({
      roleTarget: "Founder",
      firstName: "",
      lastName: "",
      keySuffix: "founder-0",
    });
  } else {
    planned.push({
      roleTarget: "Founder",
      firstName: founders[0].firstName,
      lastName: founders[0].lastName,
      keySuffix: "founder-0",
    });

    for (let i = 1; i < founders.length; i += 1) {
      const founder = founders[i];
      planned.push({
        roleTarget: "Co-Founder",
        firstName: founder.firstName,
        lastName: founder.lastName,
        keySuffix: `cofounder-${i}`,
      });
    }
  }

  for (const roleTarget of NON_FOUNDER_ROLES) {
    planned.push({
      roleTarget,
      firstName: "",
      lastName: "",
      keySuffix: roleTarget.toLowerCase().replace(/\s+/g, "-"),
    });
  }

  return planned;
};

const shouldSkipStatus = (status: string, force: boolean): boolean => {
  if (status === "done" && !force) {
    return true;
  }
  return false;
};

export async function enrichPeople(options: {
  companyDb: CompanyDb;
  peopleDb: PeopleDb;
  kickstarterDb: KickstarterDb;
  proxycurlApiKey: string;
  force: boolean;
  dryRun: boolean;
  limit?: number;
  kickstarterUrl?: string;
}): Promise<void> {
  const companies = await options.companyDb.listForPeopleEnrichment();
  const sourceCampaigns = await options.kickstarterDb.listCampaigns();
  const sourceMap = new Map(sourceCampaigns.map((item) => [item.kickstarterUrlKey, item]));

  const scoped = options.kickstarterUrl
    ? companies.filter((company) => company.kickstarterUrlRaw === options.kickstarterUrl)
    : companies;
  const capped = options.limit ? scoped.slice(0, options.limit) : scoped;

  logger.info(`[enrich-people] Starting... ${capped.length} companies eligible, up to ~${capped.length * 4} Proxycurl lookups.`);

  if (options.dryRun) {
    logger.info("[enrich-people] Dry run enabled: skipping Proxycurl and Notion writes.");
    return;
  }

  let done = 0;
  let needsReview = 0;
  let failed = 0;

  for (let i = 0; i < capped.length; i += 1) {
    const company = capped[i];
    const source = sourceMap.get(company.kickstarterUrlKey);
    const plannedRoles = buildPlannedRoles(source?.founderCreator || "");

    const roleOutputs: string[] = [];

    for (const plannedRole of plannedRoles) {
      const roleTarget = plannedRole.roleTarget;
      const personKey = `${company.kickstarterUrlKey}|${plannedRole.keySuffix}`;
      const existing = await options.peopleDb.findByPersonKey(personKey);
      if (existing && shouldSkipStatus(existing.status, options.force)) {
        roleOutputs.push(`${roleTarget}: skipped`);
        continue;
      }

      let firstName = plannedRole.firstName;
      let lastName = plannedRole.lastName;
      let fullName = [firstName, lastName].filter(Boolean).join(" ") || NOT_FOUND;
      let roleFinal: string = roleTarget;
      let linkedInPersonUrl = NOT_FOUND;
      let jobTitle = NOT_FOUND;
      let country = NOT_FOUND;
      let status: "done" | "partial" | "needs_review" | "failed" = "needs_review";
      let confidence: "high" | "medium" | "low" = "low";
      let sourceNotes = "No contact name available in source data";
      let sourcesUsed = "kickstarter_listing";
      let emailStatus: "verified" | "risky" | "not_found" = "not_found";
      let workEmail: string | null = null;

      if (firstName) {
        sourceNotes = "Name from Kickstarter listing";
      }

      const proxyRole = PROXY_ROLE_TARGET[roleTarget];
      const proxy = await findPersonByRole(options.proxycurlApiKey, company.campaignName, proxyRole);

      logger.info(
        `[proxycurl-response] ${JSON.stringify({
          campaignName: company.campaignName,
          roleTarget,
          proxyRole,
          sourceNotes: proxy.sourceNotes,
          person: proxy.person
            ? {
                fullName: proxy.person.fullName,
                firstName: proxy.person.firstName,
                lastName: proxy.person.lastName,
                linkedinProfileUrl: proxy.person.linkedinProfileUrl,
                occupation: proxy.person.occupation,
                headline: proxy.person.headline,
                country: proxy.person.country,
                roleFinal: proxy.person.roleFinal,
              }
            : null,
        })}`,
      );

      if (proxy.person) {
        firstName = proxy.person.firstName || firstName;
        lastName = proxy.person.lastName || lastName;
        fullName = proxy.person.fullName || [firstName, lastName].filter(Boolean).join(" ") || NOT_FOUND;
        linkedInPersonUrl = proxy.person.linkedinProfileUrl || NOT_FOUND;
        jobTitle = proxy.person.occupation || proxy.person.headline || NOT_FOUND;
        country = proxy.person.country || NOT_FOUND;
        roleFinal = proxy.person.roleFinal || roleFinal;
        status = "done";
        confidence = "high";
        sourceNotes = `${sourceNotes}; ${proxy.sourceNotes}`;
        sourcesUsed = `${sourcesUsed}|proxycurl_role`;
      }

      if (!firstName) {
        fullName = NOT_FOUND;
        status = "needs_review";
        sourceNotes = `${sourceNotes}; ${proxy.sourceNotes}; no person name for role ${roleTarget}`;
      }

      if (status === "done") {
        emailStatus = "risky";
        workEmail = null;
      }

      await options.peopleDb.upsert(existing?.pageId ?? null, {
        personKey,
        fullName,
        firstName,
        lastName,
        kickstarterUrlKey: company.kickstarterUrlKey,
        kickstarterUrlRaw: company.kickstarterUrlRaw,
        campaignName: company.campaignName,
        companyName: company.companyName || company.campaignName || NOT_FOUND,
        companyDomain: company.companyDomain || NOT_FOUND,
        country,
        roleTarget,
        roleFinal,
        jobTitle,
        linkedInPersonUrl,
        workEmail,
        emailStatus,
        status,
        matchConfidence: confidence,
        sourceNotes,
        sourcesUsed,
        companyEnrichedPageId: company.pageId,
      });

      if (status === "done") {
        done += 1;
      } else if (status === "needs_review") {
        needsReview += 1;
      } else {
        failed += 1;
      }

      roleOutputs.push(`${roleTarget}: ${fullName} (${emailStatus})`);
    }

    logger.info(`[${String(i + 1).padStart(3)}/${capped.length}] ✓ ${company.campaignName} - ${roleOutputs.join(" | ")}`);
  }

  logger.info(`[enrich-people] Done. ${done} done, ${needsReview} needs_review, ${failed} failed.`);
}
