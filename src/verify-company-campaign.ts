/**
 * Verify 1:1 mapping between Companies and Campaigns.
 * Usage: tsx src/verify-company-campaign.ts
 */
import { Client } from "@notionhq/client";
import { config as loadDotenv } from "dotenv";
import { homedir } from "node:os";

const secretsPath = (process.env.SECRETS_ENV_PATH?.trim() || "~/.config/env-variables/secrets.env").replace("~", homedir());
loadDotenv();
loadDotenv({ path: secretsPath, override: false });

const notion = new Client({ auth: process.env.NOTION_TOKEN?.trim() || "" });
const CAMPAIGN_DB = process.env.NOTION_KICKSTARTER_DB_ID?.trim() || "";
const COMPANY_DB = process.env.NOTION_COMPANY_ENRICHED_DB_ID?.trim() || "";

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
type Page = { id: string; properties: Record<string, any> };

async function queryAll(dbId: string): Promise<Page[]> {
  const results: Page[] = [];
  let cursor: string | undefined;
  do {
    const resp: any = await notion.databases.query({ database_id: dbId, page_size: 100, start_cursor: cursor });
    results.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor ?? undefined : undefined;
    if (cursor) await sleep(350);
  } while (cursor);
  return results;
}

function getRelationIds(page: Page, prop: string): string[] {
  const val = page.properties[prop];
  if (!val || val.type !== "relation") return [];
  return (val.relation || []).map((r: any) => r.id);
}

function getTitle(page: Page): string {
  for (const val of Object.values(page.properties) as any[]) {
    if (val?.type === "title") return (val.title || []).map((t: any) => t.plain_text).join("");
  }
  return "";
}

async function main() {
  const [companies, campaigns] = await Promise.all([queryAll(COMPANY_DB), queryAll(CAMPAIGN_DB)]);

  const companyById = new Map<string, string>();
  const campaignById = new Map<string, string>();
  for (const c of companies) companyById.set(c.id, getTitle(c));
  for (const c of campaigns) campaignById.set(c.id, getTitle(c));

  // === Companies → Campaigns ===
  console.log("=== COMPANY → CAMPAIGN LINKS ===\n");
  let companyLinked = 0;
  let companyUnlinked = 0;
  const companiesWithoutCampaign: string[] = [];

  for (const c of companies) {
    const name = getTitle(c);
    const campaignIds = getRelationIds(c, "Campaigns");
    if (campaignIds.length > 0) {
      companyLinked++;
      const campaignNames = campaignIds.map(id => campaignById.get(id) || `<unknown:${id}>`);
      console.log(`  ✓ "${name}" → [${campaignNames.join(", ")}]`);
    } else {
      companyUnlinked++;
      companiesWithoutCampaign.push(name);
      console.log(`  ✗ "${name}" → NO CAMPAIGN`);
    }
  }

  // === Campaigns → Companies ===
  console.log("\n=== CAMPAIGN → COMPANY LINKS ===\n");
  let campaignLinked = 0;
  let campaignUnlinked = 0;
  const campaignsWithoutCompany: string[] = [];

  for (const c of campaigns) {
    const name = getTitle(c);
    const companyIds = getRelationIds(c, "Companies");
    if (companyIds.length > 0) {
      campaignLinked++;
      const companyNames = companyIds.map(id => companyById.get(id) || `<unknown:${id}>`);
      console.log(`  ✓ "${name}" → [${companyNames.join(", ")}]`);
    } else {
      campaignUnlinked++;
      campaignsWithoutCompany.push(name);
      console.log(`  ✗ "${name}" → NO COMPANY`);
    }
  }

  // === Summary ===
  console.log("\n=== SUMMARY ===\n");
  console.log(`Companies: ${companyLinked}/${companies.length} linked to campaign(s) ${companyUnlinked === 0 ? "✓" : `(${companyUnlinked} missing)`}`);
  console.log(`Campaigns: ${campaignLinked}/${campaigns.length} linked to company(ies) ${campaignUnlinked === 0 ? "✓" : `(${campaignUnlinked} missing)`}`);

  if (companiesWithoutCampaign.length > 0) {
    console.log(`\nCompanies WITHOUT campaign:`);
    for (const n of companiesWithoutCampaign) console.log(`  - "${n}"`);
  }
  if (campaignsWithoutCompany.length > 0) {
    console.log(`\nCampaigns WITHOUT company:`);
    for (const n of campaignsWithoutCompany) console.log(`  - "${n}"`);
  }

  // Check for duplicate company name (Levanta appeared twice)
  const nameCount = new Map<string, number>();
  for (const c of companies) {
    const n = getTitle(c);
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
  }
  const dupeNames = [...nameCount.entries()].filter(([, c]) => c > 1);
  if (dupeNames.length > 0) {
    console.log(`\n⚠ Duplicate company names:`);
    for (const [n, c] of dupeNames) console.log(`  - "${n}" appears ${c} times`);
  }
}

main().catch(console.error);
