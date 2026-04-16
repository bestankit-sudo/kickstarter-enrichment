/**
 * Migrate enrichment data from Company/People Enriched → Extractions table.
 *
 * Usage:
 *   tsx src/migrate-to-extractions.ts companies    — migrate Company Enriched data
 *   tsx src/migrate-to-extractions.ts people       — migrate People Enriched data
 *   tsx src/migrate-to-extractions.ts verify       — verify all data migrated
 *   tsx src/migrate-to-extractions.ts drop-columns — drop moved columns from Company/People
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
const EXTRACTIONS_DB = "0d9490bf83924811acd83cd555f8c8fb";

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

function getRelationIds(page: Page, prop: string): string[] {
  const val = page.properties[prop];
  if (!val || val.type !== "relation") return [];
  return (val.relation || []).map((r: any) => r.id);
}

function getDate(page: Page, prop: string): string {
  const val = page.properties[prop];
  if (!val || val.type !== "date" || !val.date) return "";
  return val.date.start || "";
}

function truncate(s: string, max = 2000): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

async function createExtraction(properties: Record<string, any>, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await notion.pages.create({
        parent: { database_id: EXTRACTIONS_DB },
        properties: properties as any,
      });
      return result;
    } catch (e: any) {
      if (e?.status === 429) { await sleep(2000 * (i + 1)); continue; }
      throw e;
    }
  }
}

// ─── Migrate Company Enriched → Extractions ───
async function migrateCompanies() {
  console.log("\n=== Migrating Company Enriched → Extractions ===\n");

  const companies = await queryAll(COMPANY_DB);
  console.log(`Fetched ${companies.length} companies.\n`);

  let created = 0;
  let skipped = 0;

  for (const c of companies) {
    const name = getTitle(c);
    const sourceNotes = getRichText(c, "Source Notes").trim();
    const sourcesUsed = getRichText(c, "Sources Used").trim();
    const lastCheckedAt = getDate(c, "Last Checked At");
    const enrichmentStatus = getSelect(c, "Enrichment Status");
    const campaignIds = getRelationIds(c, "Campaigns");

    // Skip if no enrichment data to migrate
    if (!sourceNotes && !sourcesUsed && !lastCheckedAt) {
      skipped++;
      continue;
    }

    // Determine source type from Sources Used
    let source = "website_scrape";
    if (sourcesUsed.includes("apollo_org")) source = "apollo_org";
    if (sourcesUsed.includes("website_scrape|apollo_org")) source = "website_scrape";

    // Determine status
    let status = "accepted";
    if (enrichmentStatus === "failed") status = "rejected";
    else if (enrichmentStatus === "needs_review") status = "raw";

    const properties: Record<string, any> = {
      "Extraction": { title: [{ text: { content: `Company enrichment: ${name}` } }] },
      "Type": { select: { name: "company" } },
      "Source": { select: { name: source } },
      "Status": { select: { name: status } },
      "Source Notes": { rich_text: sourceNotes ? [{ text: { content: truncate(sourceNotes) } }] : [] },
      "Source Query": { rich_text: sourcesUsed ? [{ text: { content: sourcesUsed } }] : [] },
      "Credits Used": { number: source === "apollo_org" ? 1 : 0 },
      "Company": { relation: [{ id: c.id }] },
    };

    if (lastCheckedAt) {
      properties["Extracted At"] = { date: { start: lastCheckedAt } };
    }

    if (campaignIds.length > 0) {
      properties["Campaign"] = { relation: [{ id: campaignIds[0] }] };
    }

    await createExtraction(properties);
    created++;
    console.log(`  [${created}] ${name} → ${source} (${status})`);
    await sleep(350);
  }

  console.log(`\nCompany extractions created: ${created}`);
  console.log(`Skipped (no data): ${skipped}`);
}

// ─── Migrate People Enriched → Extractions ───
async function migratePeople() {
  console.log("\n=== Migrating People Enriched → Extractions ===\n");

  const people = await queryAll(PEOPLE_DB);
  console.log(`Fetched ${people.length} people.\n`);

  let created = 0;
  let skipped = 0;

  for (const p of people) {
    const name = getTitle(p);
    const evidenceSummary = getRichText(p, "Evidence Summary").trim();
    const matchNotes = getRichText(p, "Match Notes").trim();
    const discoveryMethod = getSelect(p, "Discovery Method");
    const lastEnrichedAt = getRichText(p, "Last Enriched At").trim();
    const lastError = getRichText(p, "Last Error").trim();
    const matchConfidence = getSelect(p, "Match Confidence");
    const enrichStatus = getSelect(p, "Enrich Status");
    const apolloPersonId = getRichText(p, "Apollo Person ID").trim();
    const companyIds = getRelationIds(p, "Linked Company");
    const campaignIds = getRelationIds(p, "Campaigns");

    // Skip if no enrichment data to migrate
    if (!evidenceSummary && !matchNotes && !lastEnrichedAt) {
      skipped++;
      continue;
    }

    // Determine source from discovery method
    let source = "apollo_reveal";
    if (discoveryMethod === "serp_fallback") source = "brave_serp";
    else if (discoveryMethod === "manual") source = "manual";
    else if (discoveryMethod === "founder_direct") source = "apollo_search";

    // Determine status
    let status = "accepted";
    if (enrichStatus === "failed") status = "rejected";
    else if (enrichStatus === "needs_review") status = "raw";
    else if (enrichStatus === "partial") status = "accepted";

    // Build raw data from available fields
    const rawData: Record<string, string> = {};
    if (apolloPersonId) rawData.apollo_person_id = apolloPersonId;
    if (matchConfidence) rawData.match_confidence = matchConfidence;
    if (lastError) rawData.last_error = lastError;
    if (evidenceSummary) rawData.evidence_summary = evidenceSummary;

    const properties: Record<string, any> = {
      "Extraction": { title: [{ text: { content: `People enrichment: ${name}` } }] },
      "Type": { select: { name: "people" } },
      "Source": { select: { name: source } },
      "Status": { select: { name: status } },
      "Source Notes": { rich_text: matchNotes ? [{ text: { content: truncate(matchNotes) } }] : [] },
      "Raw Data": { rich_text: [{ text: { content: truncate(JSON.stringify(rawData, null, 2)) } }] },
      "Credits Used": { number: source === "apollo_reveal" ? 1 : 0 },
      "Person": { relation: [{ id: p.id }] },
      "AI Validation": { rich_text: evidenceSummary ? [{ text: { content: truncate(evidenceSummary) } }] : [] },
    };

    if (lastEnrichedAt) {
      try {
        const isoDate = new Date(lastEnrichedAt).toISOString();
        properties["Extracted At"] = { date: { start: isoDate } };
      } catch { /* skip invalid dates */ }
    }

    if (companyIds.length > 0) {
      properties["Company"] = { relation: [{ id: companyIds[0] }] };
    }
    if (campaignIds.length > 0) {
      properties["Campaign"] = { relation: [{ id: campaignIds[0] }] };
    }

    await createExtraction(properties);
    created++;
    console.log(`  [${created}] ${name} → ${source} (${status})`);
    await sleep(350);
  }

  console.log(`\nPeople extractions created: ${created}`);
  console.log(`Skipped (no data): ${skipped}`);
}

// ─── Verify ───
async function verify() {
  console.log("\n=== Verify Extractions Migration ===\n");

  const [extractions, companies, people] = await Promise.all([
    queryAll(EXTRACTIONS_DB),
    queryAll(COMPANY_DB),
    queryAll(PEOPLE_DB),
  ]);

  const companyExtractions = extractions.filter(e => getSelect(e, "Type") === "company");
  const peopleExtractions = extractions.filter(e => getSelect(e, "Type") === "people");

  // Check Company Enriched has Extractions relation populated
  let companiesWithExtraction = 0;
  for (const c of companies) {
    const extractionIds = getRelationIds(c, "Extractions");
    if (extractionIds.length > 0) companiesWithExtraction++;
  }

  // Check People Enriched has Extractions relation populated
  let peopleWithExtraction = 0;
  for (const p of people) {
    const extractionIds = getRelationIds(p, "Extractions");
    if (extractionIds.length > 0) peopleWithExtraction++;
  }

  console.log(`Extractions total: ${extractions.length}`);
  console.log(`  Company type: ${companyExtractions.length}`);
  console.log(`  People type: ${peopleExtractions.length}`);
  console.log();
  console.log(`Companies with Extractions link: ${companiesWithExtraction} / ${companies.length}`);
  console.log(`People with Extractions link: ${peopleWithExtraction} / ${people.length}`);
}

// ─── Drop moved columns ───
async function dropColumns() {
  console.log("\n=== Drop Moved Columns ===\n");

  // Drop from Company Enriched
  console.log("Dropping from Company Enriched: Source Notes, Sources Used, Last Checked At...");
  await notion.databases.update({
    database_id: COMPANY_DB,
    properties: {
      "Source Notes": null,
      "Sources Used": null,
      "Last Checked At": null,
    } as any,
  });
  console.log("  Done.");

  // Drop from People Enriched
  console.log("Dropping from People Enriched: Evidence Summary, Match Notes, Discovery Method, Last Enriched At, Last Error...");
  await notion.databases.update({
    database_id: PEOPLE_DB,
    properties: {
      "Evidence Summary": null,
      "Match Notes": null,
      "Discovery Method": null,
      "Last Enriched At": null,
      "Last Error": null,
    } as any,
  });
  console.log("  Done.");
}

// ─── Main ───
const cmd = process.argv[2];
switch (cmd) {
  case "companies": await migrateCompanies(); break;
  case "people": await migratePeople(); break;
  case "verify": await verify(); break;
  case "drop-columns": await dropColumns(); break;
  default:
    console.log("Usage: tsx src/migrate-to-extractions.ts <companies|people|verify|drop-columns>");
    process.exit(1);
}
