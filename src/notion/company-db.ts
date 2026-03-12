import { NotionService } from "./client.js";
import { richTextProp, selectProp, titleProp, urlProp } from "./property.js";
import { getSelect, getTextOrUrl, getTitle, getUrl } from "./readers.js";
import type { CompanyRow, EnrichmentStatus, MatchConfidence } from "./types.js";

type CompanyUpsertInput = {
  campaignName: string;
  kickstarterUrlRaw: string;
  kickstarterUrlKey: string;
  externalLink: string;
  companyDomain: string;
  socials: {
    linkedin: string | null;
    x: string | null;
    instagram: string | null;
    facebook: string | null;
    youtube: string | null;
    tiktok: string | null;
  };
  genericBusinessEmail: string | null;
  status: EnrichmentStatus;
  matchConfidence: MatchConfidence;
  sourceNotes: string;
};

export class CompanyDb {
  constructor(
    private readonly notion: NotionService,
    private readonly databaseId: string,
  ) {}

  async findByKickstarterUrlKey(kickstarterUrlKey: string): Promise<CompanyRow | null> {
    const results = await this.notion.searchByProperty(this.databaseId, "Kickstarter URL Key", kickstarterUrlKey);
    const first = results[0];
    if (!first) {
      return null;
    }

    return {
      pageId: first.id,
      campaignName: getTitle(first, "Campaign Name"),
      kickstarterUrlRaw: getUrl(first, "Kickstarter URL (Raw)"),
      kickstarterUrlKey: getTextOrUrl(first, "Kickstarter URL Key"),
      externalLink: getTextOrUrl(first, "External Link"),
      companyDomain: getTextOrUrl(first, "Company Domain"),
      companyName: getTextOrUrl(first, "Company Name"),
      status: (getSelect(first, "Enrichment Status") || "pending") as EnrichmentStatus,
    };
  }

  async listForPeopleEnrichment(): Promise<CompanyRow[]> {
    const pages = await this.notion.queryDatabase(this.databaseId, {
      and: [
        {
          property: "Company Domain",
          url: { is_not_empty: true },
        },
        {
          or: [
            { property: "Enrichment Status", select: { equals: "done" } },
            { property: "Enrichment Status", select: { equals: "partial" } },
          ],
        },
      ],
    });

    return pages.map((page) => ({
      pageId: page.id,
      campaignName: getTitle(page, "Campaign Name"),
      kickstarterUrlRaw: getUrl(page, "Kickstarter URL (Raw)"),
      kickstarterUrlKey: getTextOrUrl(page, "Kickstarter URL Key"),
      externalLink: getTextOrUrl(page, "External Link"),
      companyDomain: getTextOrUrl(page, "Company Domain"),
      companyName: getTextOrUrl(page, "Company Name"),
      status: (getSelect(page, "Enrichment Status") || "pending") as EnrichmentStatus,
    }));
  }

  async upsert(existingPageId: string | null, input: CompanyUpsertInput): Promise<{ pageId: string }> {
    const properties: Record<string, unknown> = {
      "Campaign Name": titleProp(input.campaignName),
      "Kickstarter URL (Raw)": urlProp(input.kickstarterUrlRaw),
      "Kickstarter URL Key": urlProp(input.kickstarterUrlKey),
      "External Link": richTextProp(input.externalLink),
      "Company Domain": urlProp(input.companyDomain),
      "LinkedIn Company URL": richTextProp(input.socials.linkedin || ""),
      "X URL": richTextProp(input.socials.x || ""),
      "Instagram URL": richTextProp(input.socials.instagram || ""),
      "Facebook URL": richTextProp(input.socials.facebook || ""),
      "YouTube URL": richTextProp(input.socials.youtube || ""),
      "TikTok URL": richTextProp(input.socials.tiktok || ""),
      "Generic Business Email": richTextProp(input.genericBusinessEmail || ""),
      "Enrichment Status": selectProp(input.status),
      "Match Confidence": selectProp(input.matchConfidence),
      "Source Notes": richTextProp(input.sourceNotes),
      "Sources Used": richTextProp("website_scrape"),
    };

    if (existingPageId) {
      await this.notion.updatePage(existingPageId, properties);
      return { pageId: existingPageId };
    }

    const created = await this.notion.createPage(this.databaseId, properties);
    return { pageId: created.id };
  }
}
