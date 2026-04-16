/**
 * Stage 0: Kickstarter campaign scraper.
 *
 * Extracts campaign data from Kickstarter URLs and populates Campaign Outreach.
 * Uses stats.json (no Cloudflare) + Brave Search for metadata.
 *
 * Usage: tsx src/enrichment/kickstarter-scraper.ts [--dry-run] [--limit N] [--url <kickstarter-url>]
 */
import axios from "axios";
import { Client } from "@notionhq/client";
import { config as loadDotenv } from "dotenv";
import { homedir } from "node:os";
import { logger } from "../utils/logger.js";

const secretsPath = (process.env.SECRETS_ENV_PATH?.trim() || "~/.config/env-variables/secrets.env").replace("~", homedir());
loadDotenv();
loadDotenv({ path: secretsPath, override: false });

const notion = new Client({ auth: process.env.NOTION_TOKEN?.trim() || "" });
const CAMPAIGN_DB = process.env.NOTION_KICKSTARTER_DB_ID?.trim() || "";
const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY?.trim() || "";

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Types ───

type KickstarterStats = {
  id: number;
  state: string;
  backersCount: number;
  pledged: number;
  stateChangedAt: Date;
};

type KickstarterMetadata = {
  campaignName: string;
  creatorName: string;
  externalLink: string;
  country: string;
  category: string;
  currency: string;
  launchedAt: string;
  blurb: string;
};

type ScrapedCampaign = {
  url: string;
  stats: KickstarterStats | null;
  metadata: KickstarterMetadata | null;
};

// ─── Parse Kickstarter URL ───

function parseKickstarterUrl(url: string): { creatorSlug: string; projectSlug: string } | null {
  const match = url.match(/kickstarter\.com\/projects\/([^/]+)\/([^/?#]+)/);
  if (!match) return null;
  return { creatorSlug: match[1], projectSlug: match[2] };
}

// ─── Fetch stats.json (works without Cloudflare) ───

async function fetchStats(creatorSlug: string, projectSlug: string): Promise<KickstarterStats | null> {
  try {
    const url = `https://www.kickstarter.com/projects/${creatorSlug}/${projectSlug}/stats.json`;
    const resp = await axios.get(url, { timeout: 10_000 });
    const p = resp.data?.project;
    if (!p) return null;

    return {
      id: p.id,
      state: p.state || "",
      backersCount: p.backers_count || 0,
      pledged: parseFloat(p.pledged) || 0,
      stateChangedAt: new Date(p.state_changed_at * 1000),
    };
  } catch (error) {
    logger.warn(`[stats] Failed for ${creatorSlug}/${projectSlug}: ${error instanceof Error ? error.message : "unknown"}`);
    return null;
  }
}

// ─── Brave Search for project metadata ───

async function searchMetadata(projectSlug: string, creatorSlug: string): Promise<KickstarterMetadata | null> {
  if (!BRAVE_KEY) {
    logger.warn("[brave] No Brave Search API key — skipping metadata search");
    return null;
  }

  const query = `kickstarter "${projectSlug.replace(/-/g, " ")}" ${creatorSlug}`;

  try {
    const resp = await axios.get("https://api.search.brave.com/res/v1/web/search", {
      params: { q: query, count: 5, text_decorations: false },
      headers: { "X-Subscription-Token": BRAVE_KEY, Accept: "application/json" },
      timeout: 10_000,
    });

    const results = resp.data?.web?.results || [];
    let metadata: KickstarterMetadata = {
      campaignName: "",
      creatorName: "",
      externalLink: "",
      country: "",
      category: "",
      currency: "USD",
      launchedAt: "",
      blurb: "",
    };

    // Extract from search results
    for (const result of results) {
      const title = result.title || "";
      const description = result.description || "";
      const url = result.url || "";

      // Kickstarter result: title is usually "Campaign Name by Creator Name — Kickstarter"
      if (url.includes("kickstarter.com/projects/") && !metadata.campaignName) {
        const byMatch = title.match(/^(.+?)\s+by\s+(.+?)(?:\s+[—–-]\s+Kickstarter)?$/i);
        if (byMatch) {
          metadata.campaignName = byMatch[1].trim();
          metadata.creatorName = byMatch[2].trim();
        } else {
          // Fallback: just use title without " — Kickstarter"
          metadata.campaignName = title.replace(/\s*[—–-]\s*Kickstarter.*$/i, "").trim();
        }
        if (description) {
          metadata.blurb = description.slice(0, 300);
        }
      }

      // Non-Kickstarter result with creator's domain: likely their external website
      if (!url.includes("kickstarter.com") && !url.includes("facebook.com") &&
          !url.includes("instagram.com") && !url.includes("twitter.com") &&
          !url.includes("linkedin.com") && !url.includes("youtube.com") &&
          !url.includes("reddit.com") && !url.includes("wikipedia.org") &&
          !metadata.externalLink) {
        metadata.externalLink = url;
      }
    }

    // If we didn't find campaign name, derive from slug
    if (!metadata.campaignName) {
      metadata.campaignName = projectSlug
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    return metadata;
  } catch (error) {
    logger.warn(`[brave] Search failed for ${projectSlug}: ${error instanceof Error ? error.message : "unknown"}`);
    return null;
  }
}

// ─── Derive currency from pledged amount ───

function guessCurrency(pledged: number, country: string): string {
  // stats.json doesn't return currency, so we make best guesses
  if (country?.toLowerCase().includes("uk") || country?.toLowerCase().includes("united kingdom")) return "GBP";
  if (country?.toLowerCase().includes("australia")) return "AUD";
  if (country?.toLowerCase().includes("canada")) return "CAD";
  if (country?.toLowerCase().includes("europe") || country?.toLowerCase().includes("germany") || country?.toLowerCase().includes("france")) return "EUR";
  return "USD";
}

// ─── Scrape single campaign ───

export async function scrapeCampaign(kickstarterUrl: string): Promise<ScrapedCampaign> {
  const parsed = parseKickstarterUrl(kickstarterUrl);
  if (!parsed) {
    return { url: kickstarterUrl, stats: null, metadata: null };
  }

  const stats = await fetchStats(parsed.creatorSlug, parsed.projectSlug);
  await sleep(500);
  const metadata = await searchMetadata(parsed.projectSlug, parsed.creatorSlug);

  return { url: kickstarterUrl, stats, metadata };
}

// ─── Write to Notion Campaign Outreach ───

async function writeCampaign(scraped: ScrapedCampaign): Promise<string | null> {
  const { stats, metadata } = scraped;
  if (!metadata?.campaignName) {
    logger.warn(`[write] Skipping ${scraped.url} — no campaign name`);
    return null;
  }

  const currency = guessCurrency(stats?.pledged || 0, metadata.country);

  const properties: Record<string, unknown> = {
    "Campaign Name": { title: [{ text: { content: metadata.campaignName } }] },
    "Kickstarter URL": { url: scraped.url },
  };

  if (metadata.externalLink) {
    properties["External Link"] = { url: metadata.externalLink };
  }
  if (metadata.country) {
    properties["Country / Location"] = { rich_text: [{ text: { content: metadata.country } }] };
  }
  if (metadata.category) {
    properties["Kickstarter Category"] = { rich_text: [{ text: { content: metadata.category } }] };
  }
  if (stats?.backersCount) {
    properties["Backers"] = { number: stats.backersCount };
  }
  if (stats?.pledged) {
    properties["Amount Pledged"] = { number: stats.pledged };
  }
  if (currency) {
    properties["Currency"] = { select: { name: currency } };
  }
  if (stats?.stateChangedAt) {
    properties["Project Last Updated"] = { date: { start: stats.stateChangedAt.toISOString().split("T")[0] } };
  }
  if (metadata.blurb) {
    properties["Research Notes"] = { rich_text: [{ text: { content: metadata.blurb } }] };
  }

  const result = await notion.pages.create({
    parent: { database_id: CAMPAIGN_DB },
    properties: properties as any,
  });

  return result.id;
}

// ─── Check if URL already exists in Campaign Outreach ───

async function findExistingByUrl(kickstarterUrl: string): Promise<string | null> {
  const results: any[] = [];
  let cursor: string | undefined;
  do {
    const resp: any = await notion.databases.query({
      database_id: CAMPAIGN_DB,
      page_size: 100,
      start_cursor: cursor,
      filter: { property: "Kickstarter URL", url: { equals: kickstarterUrl } },
    });
    results.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);

  return results.length > 0 ? results[0].id : null;
}

// ─── Main: process a list of URLs or existing records ───

export async function scrapeKickstarterCampaigns(options: {
  urls?: string[];
  dryRun: boolean;
  limit?: number;
  singleUrl?: string;
}): Promise<void> {
  let urls = options.urls || [];

  // If single URL provided, just process that
  if (options.singleUrl) {
    urls = [options.singleUrl];
  }

  // If no URLs provided, read existing Campaign Outreach records that have Kickstarter URLs
  // and check for missing data (refresh mode)
  if (urls.length === 0) {
    logger.info("[stage0] No URLs provided — reading existing Campaign Outreach records");
    const results: any[] = [];
    let cursor: string | undefined;
    do {
      const resp: any = await notion.databases.query({
        database_id: CAMPAIGN_DB,
        page_size: 100,
        start_cursor: cursor,
        filter: { property: "Kickstarter URL", url: { is_not_empty: true } },
      });
      results.push(...resp.results);
      cursor = resp.has_more ? resp.next_cursor : undefined;
      if (cursor) await sleep(350);
    } while (cursor);

    urls = results.map((r: any) => r.properties["Kickstarter URL"]?.url).filter(Boolean);
    logger.info(`[stage0] Found ${urls.length} existing Kickstarter URLs`);
  }

  const capped = options.limit ? urls.slice(0, options.limit) : urls;
  logger.info(`[stage0] Processing ${capped.length} URLs${options.dryRun ? " (dry run)" : ""}`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < capped.length; i++) {
    const url = capped[i];

    // Skip if already exists
    const existing = await findExistingByUrl(url);
    if (existing) {
      skipped++;
      logger.info(`[${i + 1}/${capped.length}] SKIP ${url} — already exists`);
      continue;
    }

    const scraped = await scrapeCampaign(url);

    if (options.dryRun) {
      logger.info(`[${i + 1}/${capped.length}] DRY RUN:`);
      logger.info(`  URL: ${url}`);
      logger.info(`  Name: ${scraped.metadata?.campaignName || "unknown"}`);
      logger.info(`  Creator: ${scraped.metadata?.creatorName || "unknown"}`);
      logger.info(`  External Link: ${scraped.metadata?.externalLink || "none"}`);
      logger.info(`  Backers: ${scraped.stats?.backersCount || "unknown"}`);
      logger.info(`  Pledged: ${scraped.stats?.pledged || "unknown"}`);
      logger.info(`  State: ${scraped.stats?.state || "unknown"}`);
      logger.info(`  Blurb: ${scraped.metadata?.blurb?.slice(0, 100) || "none"}`);
      continue;
    }

    const pageId = await writeCampaign(scraped);
    if (pageId) {
      created++;
      logger.info(`[${i + 1}/${capped.length}] CREATED: ${scraped.metadata?.campaignName} (${scraped.stats?.backersCount || 0} backers, ${scraped.stats?.state})`);
    } else {
      failed++;
      logger.warn(`[${i + 1}/${capped.length}] FAILED: ${url}`);
    }

    await sleep(500);
  }

  logger.info(`[stage0] Done. Created: ${created}, Skipped: ${skipped}, Failed: ${failed}`);
}

// ─── CLI ───

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : undefined;
const urlIdx = args.indexOf("--url");
const singleUrl = urlIdx !== -1 ? args[urlIdx + 1] : undefined;

scrapeKickstarterCampaigns({ dryRun, limit, singleUrl }).catch((e) => {
  logger.error(e instanceof Error ? e.message : "Unknown error");
  process.exit(1);
});
