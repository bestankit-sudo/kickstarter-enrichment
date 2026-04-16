/**
 * Analyze orphan people (no company link) to find matching strategies.
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

async function main() {
  const [people, companies] = await Promise.all([queryAll(PEOPLE_DB), queryAll(COMPANY_DB)]);

  // Build company lookup by domain and name keywords
  const companyDomains = new Map<string, { id: string; name: string }>();
  const companyNames = new Map<string, { id: string; name: string }>();

  for (const c of companies) {
    const name = getTitle(c);
    const companyName = getRichText(c, "Company Name").trim();
    const domainRaw = c.properties["Company Domain"]?.url || getRichText(c, "Company Domain");
    const domain = domainRaw?.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "").toLowerCase().trim();

    if (domain) companyDomains.set(domain, { id: c.id, name });
    companyNames.set(name.toLowerCase(), { id: c.id, name });
    if (companyName) companyNames.set(companyName.toLowerCase(), { id: c.id, name });
  }

  // Find orphans and check what data they have
  const orphans: Page[] = [];
  for (const p of people) {
    if (getRelationIds(p, "Linked Company").length === 0) orphans.push(p);
  }

  console.log(`Orphan people (no company): ${orphans.length}\n`);
  console.log("Checking matching signals:\n");

  let matchByEvidence = 0;
  let matchByHeadline = 0;
  let matchByEmail = 0;
  let noSignal = 0;

  for (const p of orphans) {
    const name = getTitle(p);
    const headline = getRichText(p, "Headline").trim();
    const jobTitle = getRichText(p, "Job Title").trim();
    const evidence = getRichText(p, "Evidence Summary").trim();
    const matchNotes = getRichText(p, "Match Notes").trim();
    const email = getRichText(p, "Work Emails").trim();

    let matched = false;

    // Check email domain
    if (email) {
      const emailDomain = email.split("@")[1]?.toLowerCase();
      if (emailDomain && companyDomains.has(emailDomain)) {
        const company = companyDomains.get(emailDomain)!;
        console.log(`  "${name}" → "${company.name}" (via email domain: ${emailDomain})`);
        matchByEmail++;
        matched = true;
      }
    }

    // Check evidence/headline/match notes for company name mentions
    if (!matched) {
      const searchText = `${headline} ${evidence} ${matchNotes} ${jobTitle}`.toLowerCase();
      for (const [cname, company] of companyNames) {
        // Skip very short names to avoid false positives
        if (cname.length < 4) continue;
        if (searchText.includes(cname)) {
          console.log(`  "${name}" → "${company.name}" (via text match in evidence/headline)`);
          matchByEvidence++;
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      noSignal++;
      console.log(`  "${name}" — NO SIGNAL (headline: "${headline.slice(0, 60)}", jobTitle: "${jobTitle.slice(0, 40)}")`);
    }
  }

  console.log(`\nMatching summary:`);
  console.log(`  By email domain: ${matchByEmail}`);
  console.log(`  By text match: ${matchByEvidence}`);
  console.log(`  No signal: ${noSignal}`);
}

main().catch(console.error);
