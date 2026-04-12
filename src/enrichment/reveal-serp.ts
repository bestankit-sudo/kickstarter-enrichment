import { CompanyDb } from "../notion/company-db.js";
import { PeopleDb } from "../notion/people-db.js";
import { revealByLinkedIn } from "./apollo-client.js";
import { logger } from "../utils/logger.js";

type RevealSerpOptions = {
  peopleDb: PeopleDb;
  companyDb: CompanyDb;
  apolloApiKey: string;
  openaiApiKey: string;
  dryRun: boolean;
  limit?: number;
};

export async function revealSerpCandidates(options: RevealSerpOptions): Promise<void> {
  // Query all People Enriched rows — we'll filter for SERP candidates client-side
  // since we can't filter by discovery method easily via Notion search
  const companies = await options.companyDb.listForPeopleEnrichment();

  let processed = 0;
  let revealed = 0;
  let upgraded = 0;

  for (const company of companies) {
    if (options.limit && processed >= options.limit) break;

    // For each company, search for people by looking up known SERP candidates
    // We search by the company's campaign name to find associated people
    // This is a simplified approach — in production you'd query the People DB with a filter

    // Search for people with LinkedIn URLs but no Apollo Person ID
    // These are the SERP-discovered candidates
    const pages = await options.peopleDb["notion"].queryDatabase(
      options.peopleDb["databaseId"],
      {
        and: [
          { property: "Discovery Method", select: { equals: "serp_fallback" } },
          { property: "Linkedin Person Url", rich_text: { is_not_empty: true } },
        ],
      },
    );

    for (const page of pages) {
      if (options.limit && processed >= options.limit) break;

      const linkedinUrl = getRichTextValue(page, "Linkedin Person Url");
      const fullName = getTitleValue(page, "Full Name");
      const apolloId = getRichTextValue(page, "Apollo Person ID");

      // Skip if already revealed (has Apollo Person ID)
      if (apolloId) continue;
      // Skip if no LinkedIn URL
      if (!linkedinUrl || linkedinUrl === "Not Found") continue;

      processed += 1;

      if (options.dryRun) {
        logger.info(`[dry-run] Would reveal: ${fullName} — ${linkedinUrl}`);
        continue;
      }

      logger.info(`[reveal-serp] Revealing: ${fullName} — ${linkedinUrl}`);
      const person = await revealByLinkedIn(options.apolloApiKey, linkedinUrl);

      if (person && person.name) {
        revealed += 1;

        // Update the existing row with full Apollo data
        await options.peopleDb.upsert(page.id, {
          fullName: person.name || fullName,
          firstName: person.first_name || "",
          lastName: person.last_name || "",
          headline: person.headline || "",
          companyPageId: company.pageId,
          sourceCampaignPageId: "",
          city: person.city || "",
          country: person.country || "",
          jobTitle: person.title || "",
          linkedInPersonUrl: person.linkedin_url || linkedinUrl,
          apolloPersonId: person.id || "",
          twitterXUrl: person.twitter_url || "",
          discoveryMethod: "serp_fallback",
          candidateRank: 1,
          isPrimaryCandidate: false,
          evidenceSummary: `SERP candidate revealed via Apollo. ${person.title} at ${person.organization_name}`,
          workEmails: person.email || null,
          emailStatus: person.email_status || "not_found",
          status: person.linkedin_url ? "partial" : "needs_review",
          matchConfidence: person.linkedin_url && person.email ? "medium" : "low",
          matchNotes: `Revealed from SERP fallback: ${person.name}, ${person.title} at ${person.organization_name}. Email: ${person.email || "none"} (${person.email_status || "unknown"})`,
        });

        if (person.email && person.email_status === "verified") {
          upgraded += 1;
        }

        logger.info(
          `[reveal-serp] ✓ ${person.name} — ${person.title} — ${person.linkedin_url} — ${person.email || "no email"}`,
        );
      } else {
        logger.info(`[reveal-serp] ✗ ${fullName} — Apollo could not match this LinkedIn URL`);
      }
    }

    // Only process the query once (it returns all SERP candidates across companies)
    break;
  }

  logger.info(`[reveal-serp] Done. ${processed} processed, ${revealed} revealed, ${upgraded} with verified email.`);
}

function getRichTextValue(page: Record<string, unknown>, prop: string): string {
  const properties = page.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties?.[prop]) return "";
  const rt = properties[prop];
  if (rt.type === "rich_text" && Array.isArray(rt.rich_text)) {
    return (rt.rich_text as Array<{ plain_text: string }>).map((t) => t.plain_text).join("");
  }
  return "";
}

function getTitleValue(page: Record<string, unknown>, prop: string): string {
  const properties = page.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties?.[prop]) return "";
  const t = properties[prop];
  if (t.type === "title" && Array.isArray(t.title)) {
    return (t.title as Array<{ plain_text: string }>).map((x) => x.plain_text).join("");
  }
  return "";
}
