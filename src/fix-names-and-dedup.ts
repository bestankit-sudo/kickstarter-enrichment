/**
 * Fix dirty names and dedup by name+company.
 * Usage: tsx src/fix-names-and-dedup.ts fix-names
 *        tsx src/fix-names-and-dedup.ts dedup
 */
import { Client } from "@notionhq/client";
import { config as loadDotenv } from "dotenv";
import { homedir } from "node:os";

const secretsPath = (process.env.SECRETS_ENV_PATH?.trim() || "~/.config/env-variables/secrets.env").replace("~", homedir());
loadDotenv();
loadDotenv({ path: secretsPath, override: false });

const notion = new Client({ auth: process.env.NOTION_TOKEN?.trim() || "" });
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

async function update(pageId: string, properties: Record<string, any>) {
  for (let i = 0; i < 3; i++) {
    try {
      await notion.pages.update({ page_id: pageId, properties: properties as any });
      return;
    } catch (e: any) {
      if (e?.status === 429) { await sleep(2000 * (i + 1)); continue; }
      throw e;
    }
  }
}

// ─── Parse dirty SERP names: "Name - Title - Company" or "Name - Title at Company" ───
function parseDirtyName(fullName: string): { cleanName: string; firstName: string; lastName: string; extractedTitle: string } | null {
  const separators = [" - ", " — ", " | "];
  for (const sep of separators) {
    const idx = fullName.indexOf(sep);
    if (idx === -1) continue;

    const namePart = fullName.slice(0, idx).trim();
    const rest = fullName.slice(idx + sep.length).trim();

    // Skip if name part looks like junk
    if (!namePart || namePart.includes(".com") || namePart.includes("::")) continue;

    // Extract title from rest
    let extractedTitle = "";
    const atMatch = rest.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
    if (atMatch) {
      extractedTitle = atMatch[1].trim();
    } else {
      // Could be "Title - Company" or just "Company"
      const parts = rest.split(sep);
      if (parts.length >= 1) {
        extractedTitle = parts[0].trim();
      }
    }

    const nameParts = namePart.split(/\s+/);
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    return { cleanName: namePart, firstName, lastName, extractedTitle };
  }

  // Also handle " at " pattern without separator: "maggie hanford - owner at phototag"
  // Already handled above since it has " - "

  return null;
}

// ─── Fix Names ───
async function fixNames() {
  console.log("\n=== Fix Dirty Names ===\n");

  const people = await queryAll(PEOPLE_DB);
  console.log(`Fetched ${people.length} people.\n`);

  let fixed = 0;

  for (const p of people) {
    const fullName = getTitle(p).trim();
    const firstName = getRichText(p, "First Name").trim();
    const lastName = getRichText(p, "Last Name").trim();
    const jobTitle = getRichText(p, "Job Title").trim();

    const parsed = parseDirtyName(fullName);
    if (!parsed) {
      // Also check if lastName contains junk (separator embedded)
      if (lastName.includes(" - ") || lastName.includes(" | ") || lastName.includes(" — ")) {
        const parsedFromLast = parseDirtyName(`${firstName} ${lastName}`);
        if (parsedFromLast) {
          const updates: Record<string, any> = {
            "Full Name": { title: [{ text: { content: parsedFromLast.cleanName } }] },
            "Last Name": { rich_text: [{ text: { content: parsedFromLast.lastName } }] },
          };
          // Capitalize first name if all lowercase
          if (parsedFromLast.firstName && parsedFromLast.firstName === parsedFromLast.firstName.toLowerCase()) {
            updates["First Name"] = { rich_text: [{ text: { content: capitalize(parsedFromLast.firstName) } }] };
          }
          if (parsedFromLast.lastName && parsedFromLast.lastName === parsedFromLast.lastName.toLowerCase()) {
            updates["Last Name"] = { rich_text: [{ text: { content: capitalize(parsedFromLast.lastName) } }] };
          } else {
            updates["Last Name"] = { rich_text: [{ text: { content: parsedFromLast.lastName } }] };
          }
          if (!jobTitle && parsedFromLast.extractedTitle) {
            updates["Job Title"] = { rich_text: [{ text: { content: parsedFromLast.extractedTitle } }] };
          }
          await update(p.id, updates);
          fixed++;
          console.log(`  "${fullName}" → "${parsedFromLast.cleanName}" (title: "${parsedFromLast.extractedTitle || jobTitle}")`);
          await sleep(350);
        }
      }
      continue;
    }

    const updates: Record<string, any> = {
      "Full Name": { title: [{ text: { content: parsed.cleanName } }] },
    };

    // Fix first/last name
    const newFirst = capitalize(parsed.firstName);
    const newLast = capitalize(parsed.lastName);
    updates["First Name"] = { rich_text: [{ text: { content: newFirst } }] };
    updates["Last Name"] = { rich_text: [{ text: { content: newLast } }] };

    // Extract title if job title is empty
    if (!jobTitle && parsed.extractedTitle) {
      updates["Job Title"] = { rich_text: [{ text: { content: parsed.extractedTitle } }] };
    }

    await update(p.id, updates);
    fixed++;
    console.log(`  "${fullName}" → "${parsed.cleanName}" (title: "${parsed.extractedTitle || jobTitle}")`);
    await sleep(350);
  }

  console.log(`\nFixed: ${fixed}`);
}

function capitalize(s: string): string {
  if (!s) return s;
  // Don't capitalize if it has dots/special (like "Md." or "Prof.")
  if (s.includes(".")) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Dedup by normalized name + company ───
function scoreRecord(p: Page): number {
  let score = 0;
  const email = getRichText(p, "Work Emails").trim();
  const linkedin = getRichText(p, "Linkedin Person Url").trim();
  const evidence = getRichText(p, "Evidence Summary").trim();
  const jobTitle = getRichText(p, "Job Title").trim();
  const headline = getRichText(p, "Headline").trim();
  const apolloId = getRichText(p, "Apollo Person ID").trim();
  const status = getSelect(p, "Enrich Status");

  if (apolloId) score += 10;
  if (email) score += 8;
  if (linkedin && linkedin.toLowerCase() !== "not found") score += 5;
  if (jobTitle) score += 3;
  if (headline) score += 2;
  if (evidence) score += Math.min(evidence.length / 100, 5);
  if (status === "done") score += 3;
  else if (status === "partial") score += 1;

  return score;
}

async function dedup() {
  console.log("\n=== Dedup by Name + Company ===\n");

  const people = await queryAll(PEOPLE_DB);
  console.log(`Fetched ${people.length} people.\n`);

  // Group by normalized name + company ID
  const groups = new Map<string, Page[]>();
  for (const p of people) {
    const fullName = getTitle(p).trim().toLowerCase();
    const companyIds = getRelationIds(p, "Linked Company");
    const companyKey = companyIds.sort().join(",") || "none";
    const key = `${fullName}|${companyKey}`;

    const existing = groups.get(key) ?? [];
    existing.push(p);
    groups.set(key, existing);
  }

  let dupGroups = 0;
  let archived = 0;

  for (const [key, pages] of groups) {
    if (pages.length <= 1) continue;

    dupGroups++;
    const scored = pages.map(p => ({ page: p, score: scoreRecord(p) }));
    scored.sort((a, b) => b.score - a.score);

    const winner = scored[0];
    const losers = scored.slice(1);

    console.log(`  Duplicate: "${getTitle(winner.page)}" (${pages.length}x)`);
    console.log(`    Keep: score ${winner.score}`);

    // Merge best fields from losers into winner
    const mergeUpdates: Record<string, any> = {};
    const winnerEmail = getRichText(winner.page, "Work Emails").trim();
    const winnerLinkedin = getRichText(winner.page, "Linkedin Person Url").trim();
    const winnerJobTitle = getRichText(winner.page, "Job Title").trim();
    const winnerHeadline = getRichText(winner.page, "Headline").trim();
    const winnerApolloId = getRichText(winner.page, "Apollo Person ID").trim();

    for (const { page: loser, score } of losers) {
      if (!winnerEmail) {
        const v = getRichText(loser, "Work Emails").trim();
        if (v && !mergeUpdates["Work Emails"]) mergeUpdates["Work Emails"] = { rich_text: [{ text: { content: v } }] };
      }
      if (!winnerLinkedin || winnerLinkedin.toLowerCase() === "not found") {
        const v = getRichText(loser, "Linkedin Person Url").trim();
        if (v && v.toLowerCase() !== "not found" && !mergeUpdates["Linkedin Person Url"]) mergeUpdates["Linkedin Person Url"] = { rich_text: [{ text: { content: v } }] };
      }
      if (!winnerJobTitle) {
        const v = getRichText(loser, "Job Title").trim();
        if (v && !mergeUpdates["Job Title"]) mergeUpdates["Job Title"] = { rich_text: [{ text: { content: v } }] };
      }
      if (!winnerHeadline) {
        const v = getRichText(loser, "Headline").trim();
        if (v && !mergeUpdates["Headline"]) mergeUpdates["Headline"] = { rich_text: [{ text: { content: v } }] };
      }
      if (!winnerApolloId) {
        const v = getRichText(loser, "Apollo Person ID").trim();
        if (v && !mergeUpdates["Apollo Person ID"]) mergeUpdates["Apollo Person ID"] = { rich_text: [{ text: { content: v } }] };
      }

      console.log(`    Archive: "${getTitle(loser)}" (score ${score})`);
      await notion.pages.update({ page_id: loser.id, archived: true });
      archived++;
      await sleep(350);
    }

    if (Object.keys(mergeUpdates).length > 0) {
      await update(winner.page.id, mergeUpdates);
      console.log(`    Merged: ${Object.keys(mergeUpdates).join(", ")}`);
    }
  }

  console.log(`\nDuplicate groups: ${dupGroups}`);
  console.log(`Archived: ${archived}`);
  console.log(`Remaining: ${people.length - archived}`);
}

// ─── Main ───
const cmd = process.argv[2];
switch (cmd) {
  case "fix-names": await fixNames(); break;
  case "dedup": await dedup(); break;
  default: console.log("Usage: tsx src/fix-names-and-dedup.ts <fix-names|dedup>"); process.exit(1);
}
