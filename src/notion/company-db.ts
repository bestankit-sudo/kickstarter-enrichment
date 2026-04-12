import { NotionService } from "./client.js";
import {
  dateProp,
  numberProp,
  relationProp,
  richTextProp,
  selectProp,
  titleProp,
  truncateForNotion,
  urlProp,
} from "./property.js";
import { getSelect, getTextOrUrl, getTitle, getUrl, getRichText } from "./readers.js";
import type {
  BestOutreachPath,
  CompanyOutreachReadiness,
  CompanyRow,
  EnrichmentStatus,
  MatchConfidence,
} from "./types.js";
import type { ApolloOrgFromReveal } from "../enrichment/apollo-client.js";

type CompanyUpsertInput = {
  campaignName: string;
  sourceCampaignPageId?: string;
  externalLink: string;
  companyDomain: string;
  companyName?: string;
  companyDescription?: string;
  companyCountry?: string;
  socials: {
    linkedin: string | null;
    x: string | null;
    instagram: string | null;
    facebook: string | null;
    youtube: string | null;
    tiktok: string | null;
  };
  genericBusinessEmail: string | null;
  contactFormUrl?: string | null;
  apolloOrgId?: string | null;
  employeeCount?: number | null;
  status: EnrichmentStatus;
  matchConfidence: MatchConfidence;
  sourceNotes: string;
  sourcesUsed?: string;
};

type CompanyRollupInput = {
  bestPersonPageId: string | null;
  bestOutreachPath: BestOutreachPath | null;
  primaryPersonConfidence: MatchConfidence | null;
  companyOutreachReadiness: CompanyOutreachReadiness;
};

function readCompanyRow(page: { id: string; [key: string]: unknown }): CompanyRow {
  return {
    pageId: page.id,
    campaignName: getTitle(page, "Campaign Name"),
    kickstarterUrlRaw: "",
    kickstarterUrlKey: "",
    externalLink: getTextOrUrl(page, "External Link"),
    companyDomain: getTextOrUrl(page, "Company Domain"),
    companyName: getTextOrUrl(page, "Company Name"),
    companyDescription: getRichText(page, "Company Description"),
    status: (getSelect(page, "Enrichment Status") || "pending") as EnrichmentStatus,
    linkedinCompanyUrl: getRichText(page, "LinkedIn Company URL"),
    genericBusinessEmail: getRichText(page, "Generic Business Email"),
    apolloOrgId: getRichText(page, "Apollo Organisation ID"),
    employeeCount: null,
    industry: getRichText(page, "Industry"),
    foundedYear: null,
    totalFunding: getRichText(page, "Total Funding"),
    fundingStage: getRichText(page, "Funding Stage"),
    companyPhone: getRichText(page, "Company Phone"),
    keywords: getRichText(page, "Keywords"),
    xUrl: getRichText(page, "X URL"),
    instagramUrl: getRichText(page, "Instagram URL"),
    facebookUrl: getRichText(page, "Facebook URL"),
    youtubeUrl: getRichText(page, "YouTube URL"),
    tiktokUrl: getRichText(page, "TikTok URL"),
    contactFormUrl: getUrl(page, "Contact Form URL"),
    lastCheckedAt: getRichText(page, "Last Checked At"),
  };
}

export class CompanyDb {
  constructor(
    private readonly notion: NotionService,
    private readonly databaseId: string,
  ) {}

  async findByCampaignName(campaignName: string): Promise<CompanyRow | null> {
    const results = await this.notion.searchByProperty(this.databaseId, "Campaign Name", campaignName);
    const first = results[0];
    if (!first) return null;
    return readCompanyRow(first);
  }

  async listForPeopleEnrichment(): Promise<CompanyRow[]> {
    const pages = await this.notion.queryDatabase(this.databaseId, {
      or: [
        { property: "Enrichment Status", select: { equals: "done" } },
        { property: "Enrichment Status", select: { equals: "partial" } },
        { property: "Enrichment Status", select: { equals: "failed" } },
        { property: "Enrichment Status", select: { equals: "needs_review" } },
        { property: "Enrichment Status", select: { equals: "stale" } },
      ],
    });

    return pages.map(readCompanyRow);
  }

  async upsert(existingPageId: string | null, input: CompanyUpsertInput): Promise<{ pageId: string }> {
    let existingSourceNotes = "";
    if (existingPageId) {
      const existing = await this.notion.searchByProperty(this.databaseId, "Campaign Name", input.campaignName);
      if (existing[0]) {
        existingSourceNotes = getRichText(existing[0], "Source Notes");
      }
    }

    const timestampedNotes = input.sourceNotes
      ? `[${new Date().toISOString()}] ${input.sourceNotes}`
      : "";
    const mergedNotes = existingSourceNotes
      ? `${existingSourceNotes}\n${timestampedNotes}`
      : timestampedNotes;

    const properties: Record<string, unknown> = {
      "Campaign Name": titleProp(input.campaignName),
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
      "Source Notes": richTextProp(truncateForNotion(mergedNotes)),
      "Sources Used": richTextProp(input.sourcesUsed ?? "website_scrape"),
      "Last Checked At": dateProp(new Date().toISOString()),
    };

    if (input.sourceCampaignPageId) {
      properties["Source Campaign"] = relationProp(input.sourceCampaignPageId);
    }
    if (input.companyName) properties["Company Name"] = richTextProp(input.companyName);
    if (input.companyDescription) properties["Company Description"] = richTextProp(input.companyDescription);
    if (input.companyCountry) properties["Company Country"] = richTextProp(input.companyCountry);
    if (input.contactFormUrl) properties["Contact Form URL"] = urlProp(input.contactFormUrl);
    if (input.apolloOrgId) properties["Apollo Organisation ID"] = richTextProp(input.apolloOrgId);
    if (input.employeeCount != null) properties["Employee Count"] = numberProp(input.employeeCount);

    if (existingPageId) {
      await this.notion.updatePage(existingPageId, properties);
      return { pageId: existingPageId };
    }

    const created = await this.notion.createPage(this.databaseId, properties);
    return { pageId: created.id };
  }

  async backfillFromApolloOrg(pageId: string, org: ApolloOrgFromReveal): Promise<void> {
    const properties: Record<string, unknown> = {};

    if (org.linkedin_url) properties["LinkedIn Company URL"] = richTextProp(org.linkedin_url);
    if (org.primary_domain) properties["Company Domain"] = urlProp(org.primary_domain);
    if (org.short_description) properties["Company Description"] = richTextProp(org.short_description);
    if (org.industry) properties["Industry"] = richTextProp(org.industry);
    if (org.estimated_num_employees != null) properties["Employee Count"] = numberProp(org.estimated_num_employees);
    if (org.founded_year) properties["Founded Year"] = numberProp(org.founded_year);
    if (org.total_funding_printed) properties["Total Funding"] = richTextProp(org.total_funding_printed);
    if (org.latest_funding_stage) properties["Funding Stage"] = richTextProp(org.latest_funding_stage);
    if (org.phone) properties["Company Phone"] = richTextProp(org.phone);
    if (org.keywords.length > 0) properties["Keywords"] = richTextProp(org.keywords.join(", "));
    if (org.country) properties["Company Country"] = richTextProp(`${org.city ? org.city + ", " : ""}${org.country}`);
    if (org.id) properties["Apollo Organisation ID"] = richTextProp(org.id);
    if (org.name) properties["Company Name"] = richTextProp(org.name);

    if (Object.keys(properties).length > 0) {
      await this.notion.updatePage(pageId, properties);
    }
  }

  async updateRollup(pageId: string, input: CompanyRollupInput): Promise<void> {
    const properties: Record<string, unknown> = {
      "Best Outreach Path": selectProp(input.bestOutreachPath),
      "Primary Person Confidence": selectProp(input.primaryPersonConfidence),
      "Company Outreach Readiness": selectProp(input.companyOutreachReadiness),
    };

    if (input.bestPersonPageId) {
      properties["Best Person"] = relationProp(input.bestPersonPageId);
    }

    await this.notion.updatePage(pageId, properties);
  }
}
