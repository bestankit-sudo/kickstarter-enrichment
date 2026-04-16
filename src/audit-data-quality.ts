/**
 * Data Quality Audit — queries all 3 Notion databases and reports
 * duplicates, missing fields, and status breakdowns.
 *
 * Usage: npx tsx src/audit-data-quality.ts
 */

import { config as loadDotenv } from "dotenv";
import { homedir } from "node:os";
import { NotionService } from "./notion/client.js";
import { getRichText, getSelect, getTextOrUrl, getTitle, getUrl } from "./notion/readers.js";

// ── bootstrap env ──────────────────────────────────────────────
const secretsPath = (process.env.SECRETS_ENV_PATH ?? "~/.config/env-variables/secrets.env").replace(
  /^~/,
  homedir(),
);
loadDotenv();
loadDotenv({ path: secretsPath, override: false });

const NOTION_TOKEN = (process.env.NOTION_TOKEN ?? process.env.NOTION_API_KEY ?? "").trim();
const PEOPLE_DB = (process.env.NOTION_PEOPLE_ENRICHED_DB_ID ?? "").trim();
const COMPANY_DB = (process.env.NOTION_COMPANY_ENRICHED_DB_ID ?? "").trim();
const CAMPAIGN_DB = (process.env.NOTION_KICKSTARTER_DB_ID ?? "").trim();

if (!NOTION_TOKEN || !PEOPLE_DB || !COMPANY_DB || !CAMPAIGN_DB) {
  console.error("Missing one or more required env vars (NOTION_TOKEN, NOTION_PEOPLE_ENRICHED_DB_ID, NOTION_COMPANY_ENRICHED_DB_ID, NOTION_KICKSTARTER_DB_ID)");
  process.exit(1);
}

const notion = new NotionService(NOTION_TOKEN);

// ── helpers ────────────────────────────────────────────────────
type Page = { id: string; properties: Record<string, unknown>; [k: string]: unknown };

function getRelationIds(page: Page, prop: string): string[] {
  const props = page.properties as Record<string, unknown>;
  const val = props?.[prop] as { relation?: Array<{ id: string }> } | undefined;
  return val?.relation?.map((r) => r.id) ?? [];
}

function getRollupNumber(page: Page, prop: string): number | null {
  const props = page.properties as Record<string, unknown>;
  const val = props?.[prop] as { rollup?: { number?: number | null } } | undefined;
  return val?.rollup?.number ?? null;
}

function normalizeLinkedIn(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.pathname.replace(/\/+$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "");
  }
}

function heading(title: string) {
  const line = "═".repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

function bullet(label: string, value: string | number) {
  console.log(`  • ${label}: ${value}`);
}

function printMap(label: string, map: Map<string, number> | Record<string, number>) {
  const entries = map instanceof Map ? [...map.entries()] : Object.entries(map);
  entries.sort((a, b) => b[1] - a[1]);
  console.log(`\n  ${label}:`);
  for (const [k, v] of entries) {
    console.log(`    ${k || "(empty)"} → ${v}`);
  }
}

function printDupes(label: string, dupes: [string, string[]][]) {
  if (dupes.length === 0) {
    console.log(`  ✓ No ${label} duplicates found`);
    return;
  }
  console.log(`\n  ⚠ ${dupes.length} duplicate ${label} values:`);
  for (const [key, ids] of dupes.slice(0, 15)) {
    console.log(`    "${key}" → ${ids.length} records`);
  }
  if (dupes.length > 15) console.log(`    ... and ${dupes.length - 15} more`);
}

// ── People Enriched audit ──────────────────────────────────────
async function auditPeople() {
  heading("PEOPLE ENRICHED");
  const pages = await notion.queryDatabase(PEOPLE_DB) as Page[];
  bullet("Total records", pages.length);

  // 1. Nameless people
  const nameless = pages.filter((p) => {
    const first = getRichText(p, "First Name");
    const last = getRichText(p, "Last Name");
    return !first && !last;
  });
  bullet("People with no First Name AND no Last Name", nameless.length);

  // 2. Nameless enrichment potential
  if (nameless.length > 0) {
    const namelessWithApollo = nameless.filter((p) => getRichText(p, "Apollo Person ID"));
    const namelessWithLinkedIn = nameless.filter((p) => getRichText(p, "Linkedin Person Url"));
    const namelessWithEmail = nameless.filter((p) => getRichText(p, "Work Emails"));
    console.log(`\n  Nameless people breakdown (could we re-enrich?):`);
    bullet("  With Apollo Person ID", namelessWithApollo.length);
    bullet("  With LinkedIn URL", namelessWithLinkedIn.length);
    bullet("  With Work Emails", namelessWithEmail.length);
    const namelessNoSignals = nameless.filter(
      (p) => !getRichText(p, "Apollo Person ID") && !getRichText(p, "Linkedin Person Url") && !getRichText(p, "Work Emails"),
    );
    bullet("  No signals at all (likely garbage)", namelessNoSignals.length);
  }

  // 3. Apollo Person ID duplicates
  const apolloMap = new Map<string, string[]>();
  for (const p of pages) {
    const id = getRichText(p, "Apollo Person ID");
    if (id) {
      const list = apolloMap.get(id) ?? [];
      list.push(p.id);
      apolloMap.set(id, list);
    }
  }
  const withApollo = [...apolloMap.keys()].length;
  const apolloDupes = [...apolloMap.entries()].filter(([, ids]) => ids.length > 1);
  bullet("People with Apollo Person ID", withApollo);
  printDupes("Apollo Person ID", apolloDupes);

  // 4. LinkedIn URL duplicates
  const linkedinMap = new Map<string, string[]>();
  for (const p of pages) {
    const raw = getRichText(p, "Linkedin Person Url");
    const norm = normalizeLinkedIn(raw);
    if (norm) {
      const list = linkedinMap.get(norm) ?? [];
      list.push(p.id);
      linkedinMap.set(norm, list);
    }
  }
  const withLinkedIn = [...linkedinMap.keys()].length;
  const linkedinDupes = [...linkedinMap.entries()].filter(([, ids]) => ids.length > 1);
  bullet("People with LinkedIn URL (unique normalized)", withLinkedIn);
  printDupes("LinkedIn URL", linkedinDupes);

  // 5. Full Name + Linked Company duplicates
  const nameCompanyMap = new Map<string, string[]>();
  for (const p of pages) {
    const fullName = getTextOrUrl(p, "Full Name").toLowerCase().trim();
    const companyIds = getRelationIds(p, "Company");
    const companyKey = companyIds.sort().join(",");
    if (fullName && companyKey) {
      const key = `${fullName}||${companyKey}`;
      const list = nameCompanyMap.get(key) ?? [];
      list.push(p.id);
      nameCompanyMap.set(key, list);
    }
  }
  const nameCompanyDupes = [...nameCompanyMap.entries()].filter(([, ids]) => ids.length > 1);
  printDupes("Full Name + Company", nameCompanyDupes.map(([k, ids]) => [k.split("||")[0], ids]));

  // 6. No Linked Company
  const noCompany = pages.filter((p) => getRelationIds(p, "Company").length === 0);
  bullet("People with no Linked Company relation", noCompany.length);

  // 7. No Campaigns
  const noCampaign = pages.filter((p) => getRelationIds(p, "Source Campaign").length === 0);
  bullet("People with no Source Campaign relation", noCampaign.length);

  // 8. Enrich Status breakdown
  const statusMap = new Map<string, number>();
  for (const p of pages) {
    const status = getSelect(p, "Enrich Status") || getRichText(p, "Enrich Status") || "(none)";
    statusMap.set(status, (statusMap.get(status) ?? 0) + 1);
  }
  printMap("Enrich Status breakdown", statusMap);

  // 9. Work Emails
  const withEmails = pages.filter((p) => getRichText(p, "Work Emails")).length;
  bullet("People with Work Emails", withEmails);
  bullet("People without Work Emails", pages.length - withEmails);
}

// ── Company Enriched audit ─────────────────────────────────────
async function auditCompanies() {
  heading("COMPANY ENRICHED");
  const pages = await notion.queryDatabase(COMPANY_DB) as Page[];
  bullet("Total records", pages.length);

  // 1. No Company Domain
  const noDomain = pages.filter((p) => !getTextOrUrl(p, "Company Domain"));
  bullet("Companies with no Company Domain", noDomain.length);

  // 2. No Apollo Organisation ID
  const noApollo = pages.filter((p) => !getRichText(p, "Apollo Organisation ID"));
  bullet("Companies with no Apollo Organisation ID", noApollo.length);

  // 3. Companies with 0 All People (check relation "All People" or similar)
  // The relation from Company -> People is typically named by the related DB.
  // We'll check for any relation that looks like people.
  const noPeople = pages.filter((p) => {
    // Try common relation names
    const people = getRelationIds(p, "People Enriched")
      ?? getRelationIds(p, "All People")
      ?? getRelationIds(p, "People");
    return people.length === 0;
  });
  bullet("Companies with 0 linked People", noPeople.length);

  // 4. No Campaigns relation
  const noCampaign = pages.filter((p) => {
    const campaigns = getRelationIds(p, "Source Campaign")
      ?? getRelationIds(p, "Campaigns")
      ?? getRelationIds(p, "Campaign Outreach");
    return campaigns.length === 0;
  });
  bullet("Companies with no Campaign relation", noCampaign.length);

  // 5. Enrichment Status breakdown
  const statusMap = new Map<string, number>();
  for (const p of pages) {
    const status = getSelect(p, "Enrichment Status") || "(none)";
    statusMap.set(status, (statusMap.get(status) ?? 0) + 1);
  }
  printMap("Enrichment Status breakdown", statusMap);
}

// ── Campaign Outreach audit ────────────────────────────────────
async function auditCampaigns() {
  heading("CAMPAIGN OUTREACH");
  const pages = await notion.queryDatabase(CAMPAIGN_DB) as Page[];
  bullet("Total records", pages.length);

  // Campaign -> People relation and Campaign -> Companies relation
  // The relation names depend on the Notion setup. We try several names.
  let zeroPeople = 0;
  let zeroCompanies = 0;
  let zeroBoth = 0;

  for (const p of pages) {
    const people = [
      ...getRelationIds(p, "People Enriched"),
      ...getRelationIds(p, "People"),
      ...getRelationIds(p, "All People"),
    ];
    const companies = [
      ...getRelationIds(p, "Company Enriched"),
      ...getRelationIds(p, "Companies"),
      ...getRelationIds(p, "Company"),
    ];

    const hasPeople = people.length > 0;
    const hasCompanies = companies.length > 0;

    if (!hasPeople) zeroPeople++;
    if (!hasCompanies) zeroCompanies++;
    if (!hasPeople && !hasCompanies) zeroBoth++;
  }

  bullet("Campaigns with 0 People", zeroPeople);
  bullet("Campaigns with 0 Companies", zeroCompanies);
  bullet("Campaigns with 0 People AND 0 Companies", zeroBoth);
}

// ── main ───────────────────────────────────────────────────────
async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║          KICKSTARTER ENRICHMENT — DATA QUALITY AUDIT      ║");
  console.log("║          " + new Date().toISOString() + "              ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  await auditPeople();
  await auditCompanies();
  await auditCampaigns();

  console.log("\n" + "─".repeat(60));
  console.log("  Audit complete.");
  console.log("─".repeat(60) + "\n");
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
