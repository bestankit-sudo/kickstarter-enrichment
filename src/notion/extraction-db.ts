import { NotionService } from "./client.js";
import {
  dateProp,
  numberProp,
  relationProp,
  richTextProp,
  selectProp,
  titleProp,
  truncateForNotion,
} from "./property.js";

export type ExtractionType = "company" | "people";
export type ExtractionSource = "website_scrape" | "apollo_reveal" | "apollo_search" | "apollo_org" | "brave_serp" | "manual";
export type ExtractionStatus = "raw" | "accepted" | "rejected" | "merged";

export type ExtractionInput = {
  title: string;
  type: ExtractionType;
  source: ExtractionSource;
  status: ExtractionStatus;
  rawData?: string;
  sourceQuery?: string;
  sourceNotes?: string;
  aiValidation?: string;
  creditsUsed: number;
  companyPageId?: string;
  personPageId?: string;
  campaignPageId?: string;
};

export class ExtractionDb {
  constructor(
    private readonly notion: NotionService,
    private readonly databaseId: string,
  ) {}

  async create(input: ExtractionInput): Promise<{ pageId: string }> {
    const properties: Record<string, unknown> = {
      "Extraction": titleProp(input.title),
      "Type": selectProp(input.type),
      "Source": selectProp(input.source),
      "Status": selectProp(input.status),
      "Credits Used": numberProp(input.creditsUsed),
      "Extracted At": dateProp(new Date().toISOString()),
    };

    if (input.rawData) properties["Raw Data"] = richTextProp(truncateForNotion(input.rawData));
    if (input.sourceQuery) properties["Source Query"] = richTextProp(input.sourceQuery);
    if (input.sourceNotes) properties["Source Notes"] = richTextProp(truncateForNotion(input.sourceNotes));
    if (input.aiValidation) properties["AI Validation"] = richTextProp(truncateForNotion(input.aiValidation));
    if (input.companyPageId) properties["Company"] = relationProp(input.companyPageId);
    if (input.personPageId) properties["Person"] = relationProp(input.personPageId);
    if (input.campaignPageId) properties["Campaign"] = relationProp(input.campaignPageId);

    const created = await this.notion.createPage(this.databaseId, properties);
    return { pageId: created.id };
  }
}
