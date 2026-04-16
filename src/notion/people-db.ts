import { NotionService } from "./client.js";
import {
  checkboxProp,
  numberProp,
  relationProp,
  richTextProp,
  selectProp,
  titleProp,
  truncateForNotion,
} from "./property.js";
import { getRichText, getSelect, getTextOrUrl } from "./readers.js";
import type {
  DiscoveryMethod,
  MatchConfidence,
  PeopleEnrichStatus,
  PersonRow,
} from "./types.js";

export type PeopleUpsertInput = {
  fullName: string;
  firstName: string;
  lastName: string;
  headline: string;
  companyPageId: string;
  sourceCampaignPageId: string;
  city: string;
  country: string;
  jobTitle: string;
  linkedInPersonUrl: string;
  apolloPersonId?: string;
  twitterXUrl?: string;
  discoveryMethod?: DiscoveryMethod;
  candidateRank?: number;
  isPrimaryCandidate?: boolean;
  evidenceSummary?: string;
  workEmails: string | null;
  emailStatus: string;
  status: PeopleEnrichStatus;
  matchConfidence: MatchConfidence;
  matchNotes: string;
  lastError?: string;
};

export class PeopleDb {
  constructor(
    private readonly notion: NotionService,
    private readonly databaseId: string,
  ) {}

  async findByApolloPersonId(apolloPersonId: string): Promise<PersonRow | null> {
    if (!apolloPersonId) return null;
    const results = await this.notion.searchByProperty(this.databaseId, "Apollo Person ID", apolloPersonId);
    const first = results[0];
    if (!first) return null;
    return readPersonRow(first);
  }

  async findByFullName(fullName: string): Promise<PersonRow | null> {
    if (!fullName) return null;
    const results = await this.notion.searchByProperty(this.databaseId, "Full Name", fullName);
    const first = results[0];
    if (!first) return null;
    return readPersonRow(first);
  }

  async upsert(existingPageId: string | null, input: PeopleUpsertInput): Promise<{ pageId: string }> {
    const properties: Record<string, unknown> = {
      "Full Name": titleProp(input.fullName || "Unknown"),
      "Linked Company": relationProp(input.companyPageId),
      "Campaigns": relationProp(input.sourceCampaignPageId),
      "First Name": richTextProp(input.firstName),
      "Last Name": richTextProp(input.lastName),
      "Headline": richTextProp(input.headline || ""),
      "Linkedin Person Url": richTextProp(input.linkedInPersonUrl || ""),
      "Apollo Person ID": richTextProp(input.apolloPersonId || ""),
      "Job Title": richTextProp(input.jobTitle || ""),
      "Candidate Rank": numberProp(input.candidateRank ?? null),
      "Is Primary Candidate": checkboxProp(input.isPrimaryCandidate ?? false),
      "Work Emails": richTextProp(input.workEmails || ""),
      "Email Status": richTextProp(input.emailStatus || ""),
      "Match Confidence": selectProp(input.matchConfidence),
      "Enrich Status": selectProp(input.status),
      "City": richTextProp(input.city || ""),
      "Country": richTextProp(input.country || ""),
      "Twitter X Url": richTextProp(input.twitterXUrl || ""),
    };

    if (existingPageId) {
      await this.notion.updatePage(existingPageId, properties);
      return { pageId: existingPageId };
    }

    const created = await this.notion.createPage(this.databaseId, properties);
    return { pageId: created.id };
  }
}

function readPersonRow(page: { id: string; [key: string]: unknown }): PersonRow {
  return {
    pageId: page.id,
    personKey: "",
    status: (getSelect(page, "Enrich Status") || getRichText(page, "Enrich Status") || "pending") as PeopleEnrichStatus,
    apolloPersonId: getRichText(page, "Apollo Person ID"),
    linkedinPersonUrl: getRichText(page, "Linkedin Person Url"),
    matchConfidence: (getSelect(page, "Match Confidence") || "low") as MatchConfidence,
    isPrimaryCandidate: false,
    candidateRank: null,
    discoveryMethod: (getSelect(page, "Discovery Method") || "") as DiscoveryMethod | "",
    outreachRelevance: "",
    evidenceSummary: getRichText(page, "Evidence Summary"),
    workEmails: getRichText(page, "Work Emails"),
    emailStatus: getRichText(page, "Email Status"),
    fullName: getTextOrUrl(page, "Full Name"),
    firstName: getRichText(page, "First Name"),
    lastName: getRichText(page, "Last Name"),
    headline: getRichText(page, "Headline"),
    city: getRichText(page, "City"),
    country: getRichText(page, "Country"),
    photoUrl: "",
  };
}
