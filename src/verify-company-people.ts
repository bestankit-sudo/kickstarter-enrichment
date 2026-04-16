/**
 * Verify every company has at least one linked person.
 * Usage: tsx src/verify-company-people.ts
 */
import { Client } from "@notionhq/client";
import { config as loadDotenv } from "dotenv";
import { homedir } from "node:os";

const secretsPath = (process.env.SECRETS_ENV_PATH?.trim() || "~/.config/env-variables/secrets.env").replace("~", homedir());
loadDotenv();
loadDotenv({ path: secretsPath, override: false });

const notion = new Client({ auth: process.env.NOTION_TOKEN?.trim() || "" });
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

function getTitle(page: Page): string {
  for (const val of Object.values(page.properties) as any[]) {
    if (val?.type === "title") return (val.title || []).map((t: any) => t.plain_text).join("");
  }
  return "";
}

async function main() {
  const [companies, people] = await Promise.all([queryAll(COMPANY_DB), queryAll(PEOPLE_DB)]);

  // Build person ID → name lookup
  const personById = new Map<string, string>();
  for (const p of people) personById.set(p.id, getTitle(p));

  let withPeople = 0;
  let withoutPeople = 0;
  const missing: string[] = [];

  console.log("=== COMPANY → PEOPLE LINKS ===\n");

  for (const c of companies) {
    const name = getTitle(c);
    const peopleIds = getRelationIds(c, "All People");

    if (peopleIds.length > 0) {
      withPeople++;
      const personNames = peopleIds.map(id => personById.get(id) || `<unknown:${id}>`);
      console.log(`  ✓ "${name}" → ${peopleIds.length} people: [${personNames.join(", ")}]`);
    } else {
      withoutPeople++;
      missing.push(name);
      console.log(`  ✗ "${name}" → NO PEOPLE`);
    }
  }

  console.log(`\n=== SUMMARY ===\n`);
  console.log(`Companies with people: ${withPeople} / ${companies.length} ${withoutPeople === 0 ? "✓" : ""}`);
  console.log(`Companies without people: ${withoutPeople} / ${companies.length}`);

  if (missing.length > 0) {
    console.log(`\nCompanies that need people discovery (${missing.length}):`);
    for (const n of missing) console.log(`  - "${n}"`);
  }
}

main().catch(console.error);
