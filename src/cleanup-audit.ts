/**
 * Pre-cleanup audit: understand exact duplication and orphan state.
 * Usage: tsx src/cleanup-audit.ts
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
const PEOPLE_DB = process.env.NOTION_PEOPLE_ENRICHED_DB_ID?.trim() || "";

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

function getRichText(page: Page, prop: string): string {
  const val = page.properties[prop];
  if (!val) return "";
  if (val.type === "rich_text") return (val.rich_text || []).map((t: any) => t.plain_text).join("");
  if (val.type === "title") return (val.title || []).map((t: any) => t.plain_text).join("");
  return "";
}

function getTitle(page: Page): string {
  for (const val of Object.values(page.properties) as any[]) {
    if (val?.type === "title") return (val.title || []).map((t: any) => t.plain_text).join("");
  }
  return "";
}

function getSelect(page: Page, prop: string): string {
  const val = page.properties[prop];
  if (!val || val.type !== "select") return "";
  return val.select?.name || "";
}

async function main() {
  console.log("Fetching all databases...\n");
  const [people, companies, campaigns] = await Promise.all([
    queryAll(PEOPLE_DB),
    queryAll(COMPANY_DB),
    queryAll(CAMPAIGN_DB),
  ]);

  console.log(`People: ${people.length}, Companies: ${companies.length}, Campaigns: ${campaigns.length}\n`);

  // ========== PEOPLE: Apollo ID Duplication ==========
  console.log("=== PEOPLE: Apollo ID Duplication ===\n");
  const byApolloId = new Map<string, Page[]>();
  let peopleWithApolloId = 0;
  let peopleWithoutApolloId = 0;

  for (const p of people) {
    const apolloId = getRichText(p, "Apollo Person ID").trim();
    if (!apolloId) { peopleWithoutApolloId++; continue; }
    peopleWithApolloId++;
    const existing = byApolloId.get(apolloId) ?? [];
    existing.push(p);
    byApolloId.set(apolloId, existing);
  }

  let dupApolloGroups = 0;
  let dupApolloRecords = 0;
  const apolloDupDetails: Array<{ apolloId: string; count: number; names: string[]; hasEmail: boolean[]; statuses: string[] }> = [];

  for (const [apolloId, pages] of byApolloId) {
    if (pages.length <= 1) continue;
    dupApolloGroups++;
    dupApolloRecords += pages.length - 1; // extras to remove
    apolloDupDetails.push({
      apolloId,
      count: pages.length,
      names: pages.map(p => getTitle(p)),
      hasEmail: pages.map(p => !!getRichText(p, "Work Emails").trim()),
      statuses: pages.map(p => getSelect(p, "Enrich Status")),
    });
  }

  console.log(`  People with Apollo ID: ${peopleWithApolloId}`);
  console.log(`  People without Apollo ID: ${peopleWithoutApolloId}`);
  console.log(`  Duplicate Apollo ID groups: ${dupApolloGroups}`);
  console.log(`  Extra records to remove: ${dupApolloRecords}`);
  console.log();

  for (const d of apolloDupDetails.sort((a, b) => b.count - a.count)) {
    console.log(`  Apollo ID ${d.apolloId} (${d.count}x):`);
    for (let i = 0; i < d.count; i++) {
      console.log(`    - "${d.names[i]}" | email: ${d.hasEmail[i]} | status: ${d.statuses[i]}`);
    }
  }

  // ========== PEOPLE: Nameless ==========
  console.log("\n=== PEOPLE: Nameless Records ===\n");
  let nameless = 0;
  let namelessWithApollo = 0;
  let namelessWithLinkedin = 0;
  let namelessWithEmail = 0;

  for (const p of people) {
    const firstName = getRichText(p, "First Name").trim();
    const lastName = getRichText(p, "Last Name").trim();
    if (firstName || lastName) continue;
    nameless++;
    if (getRichText(p, "Apollo Person ID").trim()) namelessWithApollo++;
    const li = getRichText(p, "Linkedin Person Url").trim();
    if (li && li !== "not found" && li !== "Not Found") namelessWithLinkedin++;
    if (getRichText(p, "Work Emails").trim()) namelessWithEmail++;
  }

  console.log(`  Nameless people: ${nameless}`);
  console.log(`  With Apollo ID (re-enrichable): ${namelessWithApollo}`);
  console.log(`  With valid LinkedIn URL: ${namelessWithLinkedin}`);
  console.log(`  With Work Email: ${namelessWithEmail}`);

  // ========== PEOPLE: Orphans (no company, no campaign) ==========
  console.log("\n=== PEOPLE: Relation Coverage ===\n");
  let noCompany = 0;
  let noCampaign = 0;
  let noCompanyAndNoCampaign = 0;
  const orphanPeople: Array<{ name: string; id: string; hasCompany: boolean; hasCampaign: boolean }> = [];

  for (const p of people) {
    const companyIds = getRelationIds(p, "Linked Company");
    const campaignIds = getRelationIds(p, "Campaigns");
    const hasCompany = companyIds.length > 0;
    const hasCampaign = campaignIds.length > 0;
    if (!hasCompany) noCompany++;
    if (!hasCampaign) noCampaign++;
    if (!hasCompany && !hasCampaign) noCompanyAndNoCampaign++;
    if (!hasCompany || !hasCampaign) {
      orphanPeople.push({ name: getTitle(p), id: p.id, hasCompany, hasCampaign });
    }
  }

  console.log(`  No Linked Company: ${noCompany} / ${people.length}`);
  console.log(`  No Campaigns: ${noCampaign} / ${people.length}`);
  console.log(`  No Company AND no Campaign: ${noCompanyAndNoCampaign}`);

  // ========== COMPANIES: Orphans ==========
  console.log("\n=== COMPANIES: Relation Coverage ===\n");
  let companyNoPeople = 0;
  let companyNoCampaign = 0;
  let companyNoDomain = 0;
  let companyNoApollo = 0;
  const orphanCompanies: Array<{ name: string; id: string; hasPeople: boolean; hasCampaign: boolean }> = [];

  for (const c of companies) {
    const peopleIds = getRelationIds(c, "All People");
    const campaignIds = getRelationIds(c, "Campaigns");
    const hasPeople = peopleIds.length > 0;
    const hasCampaign = campaignIds.length > 0;
    const domain = getRichText(c, "Company Domain") || (c.properties["Company Domain"]?.url || "");
    const apolloOrg = getRichText(c, "Apollo Organisation ID").trim();

    if (!hasPeople) companyNoPeople++;
    if (!hasCampaign) companyNoCampaign++;
    if (!domain) companyNoDomain++;
    if (!apolloOrg) companyNoApollo++;
    if (!hasPeople || !hasCampaign) {
      orphanCompanies.push({ name: getTitle(c), id: c.id, hasPeople, hasCampaign });
    }
  }

  console.log(`  No All People: ${companyNoPeople} / ${companies.length}`);
  console.log(`  No Campaigns: ${companyNoCampaign} / ${companies.length}`);
  console.log(`  No Domain: ${companyNoDomain}`);
  console.log(`  No Apollo Org ID: ${companyNoApollo}`);

  // ========== CAMPAIGNS: Orphans ==========
  console.log("\n=== CAMPAIGNS: Relation Coverage ===\n");
  let campaignNoPeople = 0;
  let campaignNoCompany = 0;
  let campaignNoBoth = 0;

  for (const c of campaigns) {
    const peopleIds = getRelationIds(c, "People");
    const companyIds = getRelationIds(c, "Companies");
    const hasPeople = peopleIds.length > 0;
    const hasCompany = companyIds.length > 0;
    if (!hasPeople) campaignNoPeople++;
    if (!hasCompany) campaignNoCompany++;
    if (!hasPeople && !hasCompany) campaignNoBoth++;
  }

  console.log(`  No People: ${campaignNoPeople} / ${campaigns.length}`);
  console.log(`  No Companies: ${campaignNoCompany} / ${campaigns.length}`);
  console.log(`  No People AND no Companies: ${campaignNoBoth}`);

  // ========== LINKEDIN: "not found" cleanup needed ==========
  console.log("\n=== LINKEDIN URL CLEANUP ===\n");
  let notFoundLinkedin = 0;
  for (const p of people) {
    const li = getRichText(p, "Linkedin Person Url").trim().toLowerCase();
    if (li === "not found") notFoundLinkedin++;
  }
  console.log(`  "not found" LinkedIn URLs to clear: ${notFoundLinkedin}`);

  // ========== Build campaign->company mapping ==========
  console.log("\n=== CAMPAIGN <-> COMPANY MAPPING ===\n");
  // Each company's title should match a campaign — check which companies are unlinked to campaigns
  // and which campaigns are unlinked to companies
  const companyIdToName = new Map<string, string>();
  const companyIdToCampaigns = new Map<string, string[]>();
  for (const c of companies) {
    companyIdToName.set(c.id, getTitle(c));
    companyIdToCampaigns.set(c.id, getRelationIds(c, "Campaigns"));
  }

  const campaignIdToName = new Map<string, string>();
  for (const c of campaigns) {
    campaignIdToName.set(c.id, getTitle(c));
  }

  // Companies without campaign link — show which could be matched by name
  const unlinkedCompanies = orphanCompanies.filter(c => !c.hasCampaign);
  if (unlinkedCompanies.length > 0) {
    console.log(`  Companies without campaign link (${unlinkedCompanies.length}):`);
    for (const uc of unlinkedCompanies) {
      // Try to find matching campaign by name similarity
      const companyName = uc.name.toLowerCase();
      let bestMatch = "";
      for (const [, cName] of campaignIdToName) {
        if (cName.toLowerCase().includes(companyName) || companyName.includes(cName.toLowerCase())) {
          bestMatch = cName;
          break;
        }
      }
      console.log(`    - "${uc.name}" ${bestMatch ? `→ possible match: "${bestMatch}"` : "(no obvious match)"}`);
    }
  }

  // People without campaign but WITH company — could inherit campaign from company
  console.log("\n=== PEOPLE: Could inherit campaign from company ===\n");
  let canInherit = 0;
  for (const p of people) {
    const campaignIds = getRelationIds(p, "Campaigns");
    const companyIds = getRelationIds(p, "Linked Company");
    if (campaignIds.length > 0) continue;
    if (companyIds.length === 0) continue;
    // Check if their company has a campaign
    for (const cid of companyIds) {
      const companyCampaigns = companyIdToCampaigns.get(cid) ?? [];
      if (companyCampaigns.length > 0) {
        canInherit++;
        break;
      }
    }
  }
  console.log(`  People who could inherit campaign from their company: ${canInherit}`);

  console.log("\n=== SUMMARY ===\n");
  console.log(`Records to dedup (Apollo ID extras): ~${dupApolloRecords}`);
  console.log(`Nameless people to enrich/archive: ${nameless}`);
  console.log(`"not found" LinkedIn to clear: ${notFoundLinkedin}`);
  console.log(`People without company: ${noCompany}`);
  console.log(`People without campaign: ${noCampaign}`);
  console.log(`Companies without campaign: ${companyNoCampaign}`);
  console.log(`Companies without people: ${companyNoPeople}`);
  console.log(`Campaigns without people: ${campaignNoPeople}`);
  console.log(`Campaigns without companies: ${campaignNoCompany}`);
}

main().catch(console.error);
