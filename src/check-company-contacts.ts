/**
 * Check company-level contact channels for companies without people.
 * Usage: tsx src/check-company-contacts.ts
 */
import { Client } from "@notionhq/client";
import { config as loadDotenv } from "dotenv";
import { homedir } from "node:os";

const secretsPath = (process.env.SECRETS_ENV_PATH?.trim() || "~/.config/env-variables/secrets.env").replace("~", homedir());
loadDotenv();
loadDotenv({ path: secretsPath, override: false });

const notion = new Client({ auth: process.env.NOTION_TOKEN?.trim() || "" });
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

function getRichText(page: Page, prop: string): string {
  const val = page.properties[prop];
  if (!val) return "";
  if (val.type === "rich_text") return (val.rich_text || []).map((t: any) => t.plain_text).join("");
  if (val.type === "title") return (val.title || []).map((t: any) => t.plain_text).join("");
  return "";
}

function getUrl(page: Page, prop: string): string {
  const val = page.properties[prop];
  if (!val) return "";
  if (val.type === "url") return val.url || "";
  return "";
}

function getTitle(page: Page): string {
  for (const val of Object.values(page.properties) as any[]) {
    if (val?.type === "title") return (val.title || []).map((t: any) => t.plain_text).join("");
  }
  return "";
}

async function main() {
  const companies = await queryAll(COMPANY_DB);
  const noPeople = companies.filter(c => getRelationIds(c, "All People").length === 0);

  console.log(`=== ${noPeople.length} COMPANIES WITHOUT PEOPLE — CONTACT CHANNELS ===\n`);

  let withEmail = 0, withPhone = 0, withForm = 0, withLinkedin = 0, withSocial = 0, withNothing = 0;

  for (const c of noPeople) {
    const name = getTitle(c);
    const domain = getUrl(c, "Company Domain") || getRichText(c, "Company Domain");
    const email = getRichText(c, "Generic Business Email");
    const phone = getRichText(c, "Company Phone");
    const contactForm = getUrl(c, "Contact Form URL");
    const linkedin = getRichText(c, "LinkedIn Company URL");
    const instagram = getRichText(c, "Instagram URL");
    const facebook = getRichText(c, "Facebook URL");
    const x = getRichText(c, "X URL");

    const channels: string[] = [];
    if (email) channels.push(`email: ${email}`);
    if (phone) channels.push(`phone: ${phone}`);
    if (contactForm) channels.push(`contact form: ${contactForm}`);
    if (linkedin) channels.push(`linkedin: ${linkedin}`);
    if (instagram) channels.push(`instagram: ${instagram}`);
    if (facebook) channels.push(`facebook: ${facebook}`);
    if (x) channels.push(`x: ${x}`);
    if (domain) channels.push(`domain: ${domain}`);

    const hasContact = email || phone || contactForm || linkedin || instagram || facebook || x;
    const marker = hasContact ? "✓" : "✗";

    if (email) withEmail++;
    if (phone) withPhone++;
    if (contactForm) withForm++;
    if (linkedin) withLinkedin++;
    if (instagram || facebook || x) withSocial++;
    if (!email && !phone && !contactForm && !linkedin && !instagram && !facebook && !x) withNothing++;

    console.log(`${marker} "${name}"`);
    if (channels.length > 0) {
      for (const ch of channels) console.log(`    ${ch}`);
    } else {
      console.log(`    NO CONTACT INFO AT ALL`);
    }
    console.log();
  }

  console.log(`=== SUMMARY (${noPeople.length} companies without people) ===\n`);
  console.log(`  Has business email:    ${withEmail}`);
  console.log(`  Has phone:             ${withPhone}`);
  console.log(`  Has contact form URL:  ${withForm}`);
  console.log(`  Has LinkedIn company:  ${withLinkedin}`);
  console.log(`  Has social (IG/FB/X):  ${withSocial}`);
  console.log(`  NO contact channel:    ${withNothing}`);
}

main().catch(console.error);
