import { NotionService } from "./client.js";
import { getRichText, getTitle, getUrl } from "./readers.js";
import type { KickstarterCampaign } from "./types.js";
import { normalizeKickstarterUrl } from "../utils/url.js";

export class KickstarterDb {
  constructor(
    private readonly notion: NotionService,
    private readonly databaseId: string,
  ) {}

  async listCampaigns(): Promise<KickstarterCampaign[]> {
    const pages = await this.notion.queryDatabase(this.databaseId, {
      property: "Kickstarter URL",
      url: {
        is_not_empty: true,
      },
    });

    return pages
      .map((page) => {
        const campaignName = getTitle(page, "Campaign Name");
        const kickstarterUrlRaw = getUrl(page, "Kickstarter URL");
        const kickstarterUrlKey = normalizeKickstarterUrl(kickstarterUrlRaw);
        if (!kickstarterUrlKey) {
          return null;
        }

        return {
          pageId: page.id,
          campaignName,
          kickstarterUrlRaw,
          kickstarterUrlKey,
          externalLink: getUrl(page, "External Link"),
          founderCreator: getRichText(page, "Founder / Creator"),
        };
      })
      .filter((item): item is KickstarterCampaign => item !== null);
  }
}
