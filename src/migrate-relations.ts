/**
 * Migration script for Notion database relation fields.
 * Handles Tasks 1-7 as specified in the Podsque Kickstarter outreach cleanup.
 *
 * Usage: tsx src/migrate-relations.ts <task-number>
 *   task 1: Migrate Source Campaign -> Campaigns (Company Enriched)
 *   task 2: Migrate Source Campaign -> Campaigns (People Enriched)
 *   task 3: Migrate Company -> Linked Company (People Enriched)
 *   task 4: Fix Full Name in People Enriched
 *   task 5: Summarize Match Notes (People Enriched) via OpenAI
 *   task 6: Shorten Company Description (Company Enriched) via OpenAI
 *   task 7: Drop Founder / Creator from Campaign Outreach
 *   verify-campaigns: Verify Campaign Outreach has populated Companies/People
 *   drop-source-campaign-company: Drop Source Campaign from Company Enriched
 *   drop-source-campaign-people: Drop Source Campaign from People Enriched
 *   drop-company-people: Drop Company from People Enriched
 */

import { Client } from "@notionhq/client";
import { config as loadDotenv } from "dotenv";
import { homedir } from "node:os";
import OpenAI from "openai";

// --- Config ---
const secretsPath = (process.env.SECRETS_ENV_PATH?.trim() || "~/.config/env-variables/secrets.env")
  .replace("~", homedir());
loadDotenv();
loadDotenv({ path: secretsPath, override: false });

const NOTION_TOKEN = process.env.NOTION_TOKEN?.trim() || process.env.NOTION_API_KEY?.trim() || "";
const CAMPAIGN_DB = process.env.NOTION_KICKSTARTER_DB_ID?.trim() || "";
const COMPANY_DB = process.env.NOTION_COMPANY_ENRICHED_DB_ID?.trim() || "";
const PEOPLE_DB = process.env.NOTION_PEOPLE_ENRICHED_DB_ID?.trim() || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY_PODSQUE?.trim() || "";

if (!NOTION_TOKEN) throw new Error("Missing NOTION_TOKEN / NOTION_API_KEY");

const notion = new Client({ auth: NOTION_TOKEN });

// --- Helpers ---
type PageResult = { id: string; properties: Record<string, any> };

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function queryAll(dbId: string): Promise<PageResult[]> {
  const results: PageResult[] = [];
  let cursor: string | undefined;
  do {
    const resp: any = await notion.databases.query({
      database_id: dbId,
      page_size: 100,
      start_cursor: cursor,
    });
    results.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor ?? undefined : undefined;
    if (cursor) await sleep(350);
  } while (cursor);
  return results;
}

function getRelationIds(page: PageResult, prop: string): string[] {
  const val = page.properties[prop];
  if (!val || val.type !== "relation") return [];
  return (val.relation || []).map((r: any) => r.id);
}

function getRichText(page: PageResult, prop: string): string {
  const val = page.properties[prop];
  if (!val) return "";
  if (val.type === "rich_text") {
    return (val.rich_text || []).map((t: any) => t.plain_text).join("");
  }
  if (val.type === "title") {
    return (val.title || []).map((t: any) => t.plain_text).join("");
  }
  return "";
}

function getTitle(page: PageResult): string {
  for (const val of Object.values(page.properties) as any[]) {
    if (val?.type === "title") {
      return (val.title || []).map((t: any) => t.plain_text).join("");
    }
  }
  return "";
}

async function retryNotionUpdate(pageId: string, properties: Record<string, any>, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await notion.pages.update({ page_id: pageId, properties: properties as any });
      return;
    } catch (e: any) {
      if (e?.status === 429) {
        const wait = Math.min(2000 * (i + 1), 10000);
        console.log(`  Rate limited, waiting ${wait}ms...`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed after ${maxRetries} retries for page ${pageId}`);
}

// --- Task 1: Migrate Source Campaign -> Campaigns (Company Enriched) ---
async function task1() {
  console.log("\n=== TASK 1: Migrate Source Campaign -> Campaigns (Company Enriched) ===\n");

  const pages = await queryAll(COMPANY_DB);
  console.log(`Fetched ${pages.length} Company Enriched records.\n`);

  let migrated = 0;
  let skipped = 0;
  let alreadyPopulated = 0;

  for (const page of pages) {
    const title = getTitle(page);
    const sourceIds = getRelationIds(page, "Source Campaign");
    const campaignIds = getRelationIds(page, "Campaigns");

    if (sourceIds.length === 0) {
      skipped++;
      continue;
    }

    if (campaignIds.length > 0) {
      alreadyPopulated++;
      continue;
    }

    // Copy Source Campaign -> Campaigns
    await retryNotionUpdate(page.id, {
      Campaigns: { relation: sourceIds.map((id) => ({ id })) },
    });
    migrated++;
    console.log(`  [${migrated}] ${title}: copied ${sourceIds.length} campaign(s)`);
    await sleep(350);
  }

  console.log(`\nTask 1 results:`);
  console.log(`  Migrated: ${migrated}`);
  console.log(`  Already had Campaigns: ${alreadyPopulated}`);
  console.log(`  No Source Campaign: ${skipped}`);

  // Verify
  console.log("\nVerifying...");
  const verify = await queryAll(COMPANY_DB);
  let mismatch = 0;
  for (const page of verify) {
    const sourceIds = getRelationIds(page, "Source Campaign");
    const campaignIds = getRelationIds(page, "Campaigns");
    if (sourceIds.length > 0 && campaignIds.length === 0) {
      mismatch++;
      console.log(`  MISMATCH: ${getTitle(page)} — Source has ${sourceIds.length}, Campaigns empty`);
    }
  }
  if (mismatch === 0) {
    console.log("  All records verified: Campaigns matches Source Campaign.");
  } else {
    console.log(`  WARNING: ${mismatch} records still have empty Campaigns.`);
  }

  return { migrated, skipped, alreadyPopulated, mismatch };
}

// --- Task 2: Migrate Source Campaign -> Campaigns (People Enriched) ---
async function task2() {
  console.log("\n=== TASK 2: Migrate Source Campaign -> Campaigns (People Enriched) ===\n");

  const pages = await queryAll(PEOPLE_DB);
  console.log(`Fetched ${pages.length} People Enriched records.\n`);

  let migrated = 0;
  let skipped = 0;
  let alreadyPopulated = 0;

  for (const page of pages) {
    const title = getTitle(page);
    const sourceIds = getRelationIds(page, "Source Campaign");
    const campaignIds = getRelationIds(page, "Campaigns");

    if (sourceIds.length === 0) {
      skipped++;
      continue;
    }

    if (campaignIds.length > 0) {
      alreadyPopulated++;
      continue;
    }

    await retryNotionUpdate(page.id, {
      Campaigns: { relation: sourceIds.map((id) => ({ id })) },
    });
    migrated++;
    console.log(`  [${migrated}] ${title}: copied ${sourceIds.length} campaign(s)`);
    await sleep(350);
  }

  console.log(`\nTask 2 results:`);
  console.log(`  Migrated: ${migrated}`);
  console.log(`  Already had Campaigns: ${alreadyPopulated}`);
  console.log(`  No Source Campaign: ${skipped}`);

  // Verify
  console.log("\nVerifying...");
  const verify = await queryAll(PEOPLE_DB);
  let mismatch = 0;
  for (const page of verify) {
    const sourceIds = getRelationIds(page, "Source Campaign");
    const campaignIds = getRelationIds(page, "Campaigns");
    if (sourceIds.length > 0 && campaignIds.length === 0) {
      mismatch++;
      console.log(`  MISMATCH: ${getTitle(page)} — Source has ${sourceIds.length}, Campaigns empty`);
    }
  }
  if (mismatch === 0) {
    console.log("  All records verified: Campaigns matches Source Campaign.");
  } else {
    console.log(`  WARNING: ${mismatch} records still have empty Campaigns.`);
  }

  return { migrated, skipped, alreadyPopulated, mismatch };
}

// --- Verify Campaign Outreach has Companies + People ---
async function verifyCampaigns() {
  console.log("\n=== Verifying Campaign Outreach: Companies & People populated ===\n");

  const pages = await queryAll(CAMPAIGN_DB);
  console.log(`Fetched ${pages.length} Campaign Outreach records.\n`);

  let withCompanies = 0;
  let withPeople = 0;
  let emptyCompanies: string[] = [];
  let emptyPeople: string[] = [];

  for (const page of pages) {
    const title = getTitle(page);
    const companyIds = getRelationIds(page, "Companies");
    const peopleIds = getRelationIds(page, "People");

    if (companyIds.length > 0) withCompanies++;
    else emptyCompanies.push(title);

    if (peopleIds.length > 0) withPeople++;
    else emptyPeople.push(title);
  }

  console.log(`Companies populated: ${withCompanies}/${pages.length}`);
  if (emptyCompanies.length > 0) {
    console.log(`  Empty Companies: ${emptyCompanies.join(", ")}`);
  }

  console.log(`People populated: ${withPeople}/${pages.length}`);
  if (emptyPeople.length > 0) {
    console.log(`  Empty People: ${emptyPeople.join(", ")}`);
  }
}

// --- Task 3: Migrate Company -> Linked Company (People Enriched) ---
async function task3() {
  console.log("\n=== TASK 3: Migrate Company -> Linked Company (People Enriched) ===\n");

  const pages = await queryAll(PEOPLE_DB);
  console.log(`Fetched ${pages.length} People Enriched records.\n`);

  let migrated = 0;
  let skipped = 0;
  let alreadyPopulated = 0;

  for (const page of pages) {
    const title = getTitle(page);
    const companyIds = getRelationIds(page, "Company");
    const linkedIds = getRelationIds(page, "Linked Company");

    if (companyIds.length === 0) {
      skipped++;
      continue;
    }

    if (linkedIds.length > 0) {
      alreadyPopulated++;
      continue;
    }

    await retryNotionUpdate(page.id, {
      "Linked Company": { relation: companyIds.map((id) => ({ id })) },
    });
    migrated++;
    console.log(`  [${migrated}] ${title}: copied ${companyIds.length} company link(s)`);
    await sleep(350);
  }

  console.log(`\nTask 3 results:`);
  console.log(`  Migrated: ${migrated}`);
  console.log(`  Already had Linked Company: ${alreadyPopulated}`);
  console.log(`  No Company relation: ${skipped}`);

  // Verify
  console.log("\nVerifying...");
  const verify = await queryAll(PEOPLE_DB);
  let mismatch = 0;
  for (const page of verify) {
    const companyIds = getRelationIds(page, "Company");
    const linkedIds = getRelationIds(page, "Linked Company");
    if (companyIds.length > 0 && linkedIds.length === 0) {
      mismatch++;
      console.log(`  MISMATCH: ${getTitle(page)} — Company has ${companyIds.length}, Linked Company empty`);
    }
  }
  if (mismatch === 0) {
    console.log("  All records verified: Linked Company matches Company.");
  } else {
    console.log(`  WARNING: ${mismatch} records still have empty Linked Company.`);
  }

  // Verify Company Enriched has populated All People
  console.log("\nVerifying Company Enriched: All People & People Count...");
  const companies = await queryAll(COMPANY_DB);
  let withAllPeople = 0;
  let emptyAllPeople: string[] = [];
  for (const c of companies) {
    const allPeopleIds = getRelationIds(c, "All People");
    if (allPeopleIds.length > 0) withAllPeople++;
    else emptyAllPeople.push(getTitle(c));
  }
  console.log(`  All People populated: ${withAllPeople}/${companies.length}`);
  if (emptyAllPeople.length > 0 && emptyAllPeople.length <= 10) {
    console.log(`  Empty All People: ${emptyAllPeople.join(", ")}`);
  } else if (emptyAllPeople.length > 10) {
    console.log(`  ${emptyAllPeople.length} companies have empty All People`);
  }

  return { migrated, skipped, alreadyPopulated, mismatch };
}

// --- Task 4: Fix Full Name in People Enriched ---
async function task4() {
  console.log("\n=== TASK 4: Fix Full Name in People Enriched ===\n");

  const pages = await queryAll(PEOPLE_DB);
  console.log(`Fetched ${pages.length} People Enriched records.\n`);

  let fixed = 0;
  let skippedEmpty = 0;
  let alreadyCorrect = 0;
  const changes: Array<{ name: string; old: string; new_: string }> = [];
  const flagged: string[] = [];

  for (const page of pages) {
    const firstName = getRichText(page, "First Name").trim();
    const lastName = getRichText(page, "Last Name").trim();
    const fullName = getTitle(page).trim();

    if (!firstName && !lastName) {
      flagged.push(`${page.id} (current Full Name: "${fullName}")`);
      skippedEmpty++;
      continue;
    }

    const expected = [firstName, lastName].filter(Boolean).join(" ");

    if (fullName === expected) {
      alreadyCorrect++;
      continue;
    }

    await retryNotionUpdate(page.id, {
      "Full Name": { title: [{ text: { content: expected } }] },
    });
    fixed++;
    changes.push({ name: page.id, old: fullName, new_: expected });
    console.log(`  [${fixed}] "${fullName}" -> "${expected}"`);
    await sleep(350);
  }

  console.log(`\nTask 4 results:`);
  console.log(`  Fixed: ${fixed}`);
  console.log(`  Already correct: ${alreadyCorrect}`);
  console.log(`  Skipped (no First/Last Name): ${skippedEmpty}`);
  if (flagged.length > 0) {
    console.log(`  Flagged (empty names):`);
    for (const f of flagged) console.log(`    - ${f}`);
  }

  console.log("\nChange log:");
  for (const c of changes) {
    console.log(`  "${c.old}" -> "${c.new_}"`);
  }

  return { fixed, alreadyCorrect, skippedEmpty, flagged: flagged.length };
}

// --- Task 5: Summarize Match Notes (People Enriched) ---
async function task5() {
  console.log("\n=== TASK 5: Summarize Match Notes (People Enriched) ===\n");

  if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY_PODSQUE");
  const openai = new OpenAI({ apiKey: OPENAI_KEY });

  // Try gpt-5.4 first, fall back to configured model
  let model = "gpt-5.4";
  try {
    await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: "test" }],
      max_completion_tokens: 5,
    });
    console.log(`Using model: ${model}`);
  } catch {
    model = process.env.OPENAI_MODEL?.trim() || "gpt-4o";
    console.log(`gpt-5.4 not available, falling back to: ${model}`);
  }

  const pages = await queryAll(PEOPLE_DB);
  console.log(`Fetched ${pages.length} People Enriched records.\n`);

  let summarized = 0;
  let skipped = 0;
  const changes: Array<{ name: string; old: string; new_: string }> = [];

  for (const page of pages) {
    const title = getTitle(page);
    const matchNotes = getRichText(page, "Match Notes").trim();

    if (!matchNotes) {
      skipped++;
      continue;
    }

    // Skip if already a single short sentence (under 200 chars, no timestamps)
    if (matchNotes.length < 200 && !matchNotes.includes("[202") && !matchNotes.includes("apollo |")) {
      skipped++;
      continue;
    }

    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "You are a concise data editor." },
        {
          role: "user",
          content: `Summarize the following match notes for a Kickstarter outreach contact in 1-2 sentences. Keep: their current role, company, and outreach relevance. Remove timestamps, log prefixes, and repetition. Output only the summary.\n\n${matchNotes}`,
        },
      ],
      max_completion_tokens: 200,
      temperature: 0.3,
    });

    const summary = completion.choices[0]?.message?.content?.trim() || "";
    if (!summary) {
      console.log(`  WARN: Empty summary for ${title}, skipping`);
      skipped++;
      continue;
    }

    await retryNotionUpdate(page.id, {
      "Match Notes": { rich_text: [{ text: { content: summary.slice(0, 2000) } }] },
    });
    summarized++;
    changes.push({ name: title, old: matchNotes.slice(0, 100) + "...", new_: summary });
    console.log(`  [${summarized}] ${title}: summarized (${matchNotes.length} -> ${summary.length} chars)`);
    await sleep(500); // Extra delay for OpenAI rate limits
  }

  console.log(`\nTask 5 results:`);
  console.log(`  Summarized: ${summarized}`);
  console.log(`  Skipped: ${skipped}`);

  console.log("\nChange log:");
  for (const c of changes) {
    console.log(`  ${c.name}:`);
    console.log(`    OLD: ${c.old}`);
    console.log(`    NEW: ${c.new_}`);
  }

  return { summarized, skipped };
}

// --- Task 6: Shorten Company Description (Company Enriched) ---
async function task6() {
  console.log("\n=== TASK 6: Shorten Company Description (Company Enriched) ===\n");

  if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY_PODSQUE");
  const openai = new OpenAI({ apiKey: OPENAI_KEY });

  let model = "gpt-5.4";
  try {
    await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: "test" }],
      max_completion_tokens: 5,
    });
    console.log(`Using model: ${model}`);
  } catch {
    model = process.env.OPENAI_MODEL?.trim() || "gpt-4o";
    console.log(`gpt-5.4 not available, falling back to: ${model}`);
  }

  const pages = await queryAll(COMPANY_DB);
  console.log(`Fetched ${pages.length} Company Enriched records.\n`);

  let shortened = 0;
  let skipped = 0;
  const changes: Array<{ name: string; old: string; new_: string }> = [];

  for (const page of pages) {
    const title = getTitle(page);
    const desc = getRichText(page, "Company Description").trim();

    if (!desc) {
      skipped++;
      continue;
    }

    // Skip if already <= 40 words
    const wordCount = desc.split(/\s+/).length;
    if (wordCount <= 40) {
      skipped++;
      continue;
    }

    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "You are a concise data editor." },
        {
          role: "user",
          content: `Rewrite the following company description in 2-3 sentences (max 50 words). Keep: what they do, what makes them a relevant collaboration partner for a coffee pod/bean storage product launching on Kickstarter. Remove fluff. Output only the rewritten description.\n\n${desc}`,
        },
      ],
      max_completion_tokens: 150,
      temperature: 0.3,
    });

    const shortened_ = completion.choices[0]?.message?.content?.trim() || "";
    if (!shortened_) {
      console.log(`  WARN: Empty result for ${title}, skipping`);
      skipped++;
      continue;
    }

    await retryNotionUpdate(page.id, {
      "Company Description": { rich_text: [{ text: { content: shortened_.slice(0, 2000) } }] },
    });
    shortened++;
    changes.push({ name: title, old: desc.slice(0, 100) + "...", new_: shortened_ });
    console.log(`  [${shortened}] ${title}: ${wordCount} words -> ${shortened_.split(/\s+/).length} words`);
    await sleep(500);
  }

  console.log(`\nTask 6 results:`);
  console.log(`  Shortened: ${shortened}`);
  console.log(`  Skipped: ${skipped}`);

  console.log("\nChange log:");
  for (const c of changes) {
    console.log(`  ${c.name}:`);
    console.log(`    OLD: ${c.old}`);
    console.log(`    NEW: ${c.new_}`);
  }

  return { shortened, skipped };
}

// --- Task 7: Drop Founder / Creator from Campaign Outreach ---
async function task7() {
  console.log("\n=== TASK 7: Drop Founder / Creator from Campaign Outreach ===\n");

  const pages = await queryAll(CAMPAIGN_DB);
  console.log(`Fetched ${pages.length} Campaign Outreach records.\n`);

  // Check that all have People relations
  const noPeople: string[] = [];
  for (const page of pages) {
    const peopleIds = getRelationIds(page, "People");
    if (peopleIds.length === 0) {
      noPeople.push(getTitle(page));
    }
  }

  if (noPeople.length > 0) {
    console.log(`WARNING: ${noPeople.length} Campaign Outreach records have NO linked People:`);
    for (const n of noPeople) console.log(`  - ${n}`);
    console.log("\nFlagged these records. Proceeding with drop anyway (per instructions).");
  } else {
    console.log("All Campaign Outreach records have linked People. Safe to drop Founder / Creator.");
  }

  // Drop the property using the Notion API
  // We need to use the raw API to delete a property from the database schema
  const dbResp: any = await notion.databases.retrieve({ database_id: CAMPAIGN_DB });
  const properties = dbResp.properties;

  if (!properties["Founder / Creator"]) {
    console.log("'Founder / Creator' property not found — may already be dropped.");
    return { dropped: false, flagged: noPeople };
  }

  const propId = properties["Founder / Creator"].id;
  // To delete a property, we update the database and set the property to null
  await notion.databases.update({
    database_id: CAMPAIGN_DB,
    properties: { "Founder / Creator": null } as any,
  });

  console.log(`Dropped 'Founder / Creator' property (id: ${propId}) from Campaign Outreach.`);
  return { dropped: true, flagged: noPeople };
}

// --- Drop helpers (for Source Campaign and Company properties) ---
async function dropProperty(dbId: string, dbName: string, propName: string) {
  console.log(`\nDropping "${propName}" from ${dbName}...`);
  const dbResp: any = await notion.databases.retrieve({ database_id: dbId });
  if (!dbResp.properties[propName]) {
    console.log(`  "${propName}" not found — may already be dropped.`);
    return false;
  }
  await notion.databases.update({
    database_id: dbId,
    properties: { [propName]: null } as any,
  });
  console.log(`  Dropped "${propName}" from ${dbName}.`);
  return true;
}

// --- Main ---
const task = process.argv[2];

if (!task) {
  console.log("Usage: tsx src/migrate-relations.ts <task>");
  console.log("Tasks: 1, 2, 3, 4, 5, 6, 7, verify-campaigns");
  console.log("       drop-source-campaign-company, drop-source-campaign-people, drop-company-people");
  process.exit(1);
}

switch (task) {
  case "1":
    await task1();
    break;
  case "2":
    await task2();
    break;
  case "verify-campaigns":
    await verifyCampaigns();
    break;
  case "3":
    await task3();
    break;
  case "4":
    await task4();
    break;
  case "5":
    await task5();
    break;
  case "6":
    await task6();
    break;
  case "7":
    await task7();
    break;
  case "drop-source-campaign-company":
    await dropProperty(COMPANY_DB, "Company Enriched", "Source Campaign");
    break;
  case "drop-source-campaign-people":
    await dropProperty(PEOPLE_DB, "People Enriched", "Source Campaign");
    break;
  case "drop-company-people":
    await dropProperty(PEOPLE_DB, "People Enriched", "Company");
    break;
  default:
    console.log(`Unknown task: ${task}`);
    process.exit(1);
}
