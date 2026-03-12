import { NotionService } from "./client.js";
import { richTextProp, titleProp } from "./property.js";
import { getTextOrUrl } from "./readers.js";
import type { EnrichmentStatus, MatchConfidence, PersonRoleTarget, PersonRow } from "./types.js";

const NOT_FOUND = "Not Found";

type PeopleUpsertInput = {
  personKey: string;
  fullName: string;
  firstName: string;
  lastName: string;
  kickstarterUrlKey: string;
  kickstarterUrlRaw: string;
  campaignName: string;
  companyName: string;
  companyDomain: string;
  country: string;
  roleTarget: PersonRoleTarget;
  roleFinal: string;
  jobTitle: string;
  linkedInPersonUrl: string;
  workEmail: string | null;
  emailStatus: "verified" | "risky" | "not_found";
  status: EnrichmentStatus;
  matchConfidence: MatchConfidence;
  sourceNotes: string;
  sourcesUsed: string;
  companyEnrichedPageId: string;
};

export class PeopleDb {
  constructor(
    private readonly notion: NotionService,
    private readonly databaseId: string,
  ) {}

  async findByPersonKey(personKey: string): Promise<PersonRow | null> {
    const results = await this.notion.searchByProperty(this.databaseId, "Person Key", personKey);
    const first = results[0];
    if (!first) {
      return null;
    }
    return {
      pageId: first.id,
      personKey: getTextOrUrl(first, "Person Key"),
      status: (getTextOrUrl(first, "Enrich Status") || "pending") as EnrichmentStatus,
    };
  }

  async upsert(existingPageId: string | null, input: PeopleUpsertInput): Promise<{ pageId: string }> {
    const properties: Record<string, unknown> = {
      "Full Name": richTextProp(input.fullName),
      "Person Key": titleProp(input.personKey),
      "Kickstarter Url Key": richTextProp(input.kickstarterUrlKey),
      "Campaign Name": richTextProp(input.campaignName || NOT_FOUND),
      "Company Name": richTextProp(input.companyName || NOT_FOUND),
      "Company Domain": richTextProp(input.companyDomain || NOT_FOUND),
      Country: richTextProp(input.country || NOT_FOUND),
      "Role Target": richTextProp(input.roleTarget),
      "Role Final": richTextProp(input.roleFinal || NOT_FOUND),
      "Job Title": richTextProp(input.jobTitle || NOT_FOUND),
      "Linkedin Person Url": richTextProp(input.linkedInPersonUrl || NOT_FOUND),
      "Work Email": richTextProp(input.workEmail || NOT_FOUND),
      "Email Status": richTextProp(input.emailStatus),
      "Enrich Status": richTextProp(input.status),
      "Match Confidence": richTextProp(input.matchConfidence),
      "Match Notes": richTextProp(`${input.sourceNotes}${input.sourcesUsed ? ` | ${input.sourcesUsed}` : ""}`),
      "Last Enriched At": richTextProp(new Date().toISOString()),
      "First Name": richTextProp(input.firstName),
      "Last Name": richTextProp(input.lastName),
      "Twitter X Url": richTextProp(NOT_FOUND),
      "Instagram Url": richTextProp(NOT_FOUND),
      "Facebook Url": richTextProp(NOT_FOUND),
      "Youtube Url": richTextProp(NOT_FOUND),
      "Tiktok Url": richTextProp(NOT_FOUND),
    };

    if (existingPageId) {
      await this.notion.updatePage(existingPageId, properties);
      return { pageId: existingPageId };
    }

    const created = await this.notion.createPage(this.databaseId, properties);
    return { pageId: created.id };
  }
}
