/**
 * Data quality cleanup pipeline (MagMirror-inspired).
 *
 * Usage: tsx src/cleanup-pipeline.ts <phase>
 *   phase1  — Dedup people by Apollo Person ID (keep best, archive rest)
 *   phase2  — Archive remaining nameless people (no First/Last Name after dedup)
 *   phase3  — Clean dirty data (clear "not found" LinkedIn URLs)
 *   phase4  — Link companies ↔ campaigns by name match
 *   phase5  — Link people → companies (infer from campaign or name match)
 *   phase6  — Link people → campaigns (inherit from company)
 *   audit   — Final audit: zero orphans, zero dupes
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

async function update(pageId: string, properties: Record<string, any>, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await notion.pages.update({ page_id: pageId, properties: properties as any });
      return;
    } catch (e: any) {
      if (e?.status === 429) {
        await sleep(2000 * (i + 1));
        continue;
      }
      throw e;
    }
  }
}

async function archivePage(pageId: string) {
  await notion.pages.update({ page_id: pageId, archived: true });
}

// ========== Scoring for dedup (MagMirror pattern) ==========
function scoreRecord(p: Page): number {
  let score = 0;
  const firstName = getRichText(p, "First Name").trim();
  const lastName = getRichText(p, "Last Name").trim();
  const email = getRichText(p, "Work Emails").trim();
  const linkedin = getRichText(p, "Linkedin Person Url").trim();
  const evidence = getRichText(p, "Evidence Summary").trim();
  const status = getSelect(p, "Enrich Status");
  const jobTitle = getRichText(p, "Job Title").trim();
  const headline = getRichText(p, "Headline").trim();
  const companyIds = getRelationIds(p, "Linked Company");
  const campaignIds = getRelationIds(p, "Campaigns");

  // Name quality
  if (firstName && lastName) score += 10;
  else if (firstName || lastName) score += 5;

  // Contact info
  if (email) score += 8;
  if (linkedin && linkedin.toLowerCase() !== "not found") score += 5;

  // Data richness
  if (jobTitle) score += 3;
  if (headline) score += 2;
  if (evidence) score += Math.min(evidence.length / 100, 5);

  // Relations
  if (companyIds.length > 0) score += 4;
  if (campaignIds.length > 0) score += 3;

  // Status
  if (status === "done") score += 3;
  else if (status === "partial") score += 1;

  return score;
}

// ========== PHASE 1: Dedup by Apollo ID ==========
async function phase1() {
  console.log("\n=== PHASE 1: Dedup People by Apollo Person ID ===\n");

  const people = await queryAll(PEOPLE_DB);
  console.log(`Fetched ${people.length} people.\n`);

  // Group by Apollo ID
  const byApolloId = new Map<string, Page[]>();
  for (const p of people) {
    const apolloId = getRichText(p, "Apollo Person ID").trim();
    if (!apolloId) continue;
    const existing = byApolloId.get(apolloId) ?? [];
    existing.push(p);
    byApolloId.set(apolloId, existing);
  }

  let archived = 0;
  let kept = 0;
  let merged = 0;

  for (const [apolloId, dupes] of byApolloId) {
    if (dupes.length <= 1) continue;

    // Score each and sort descending
    const scored = dupes.map(p => ({ page: p, score: scoreRecord(p) }));
    scored.sort((a, b) => b.score - a.score);

    const winner = scored[0].page;
    const winnerName = getTitle(winner);
    const losers = scored.slice(1);

    // Merge: fill empty fields in winner from losers (best-of-both)
    const mergeUpdates: Record<string, any> = {};
    const winnerFirstName = getRichText(winner, "First Name").trim();
    const winnerLastName = getRichText(winner, "Last Name").trim();
    const winnerEmail = getRichText(winner, "Work Emails").trim();
    const winnerLinkedin = getRichText(winner, "Linkedin Person Url").trim();
    const winnerJobTitle = getRichText(winner, "Job Title").trim();
    const winnerHeadline = getRichText(winner, "Headline").trim();
    const winnerCompanyIds = getRelationIds(winner, "Linked Company");
    const winnerCampaignIds = getRelationIds(winner, "Campaigns");

    // Collect best values from losers
    for (const { page: loser } of losers) {
      if (!winnerFirstName) {
        const v = getRichText(loser, "First Name").trim();
        if (v && !mergeUpdates["First Name"]) {
          mergeUpdates["First Name"] = { rich_text: [{ text: { content: v } }] };
        }
      }
      if (!winnerLastName) {
        const v = getRichText(loser, "Last Name").trim();
        if (v && !mergeUpdates["Last Name"]) {
          mergeUpdates["Last Name"] = { rich_text: [{ text: { content: v } }] };
        }
      }
      if (!winnerEmail) {
        const v = getRichText(loser, "Work Emails").trim();
        if (v && !mergeUpdates["Work Emails"]) {
          mergeUpdates["Work Emails"] = { rich_text: [{ text: { content: v } }] };
        }
      }
      if (!winnerLinkedin || winnerLinkedin.toLowerCase() === "not found") {
        const v = getRichText(loser, "Linkedin Person Url").trim();
        if (v && v.toLowerCase() !== "not found" && !mergeUpdates["Linkedin Person Url"]) {
          mergeUpdates["Linkedin Person Url"] = { rich_text: [{ text: { content: v } }] };
        }
      }
      if (!winnerJobTitle) {
        const v = getRichText(loser, "Job Title").trim();
        if (v && !mergeUpdates["Job Title"]) {
          mergeUpdates["Job Title"] = { rich_text: [{ text: { content: v } }] };
        }
      }
      if (!winnerHeadline) {
        const v = getRichText(loser, "Headline").trim();
        if (v && !mergeUpdates["Headline"]) {
          mergeUpdates["Headline"] = { rich_text: [{ text: { content: v } }] };
        }
      }
      // Merge company relations
      if (winnerCompanyIds.length === 0) {
        const loserCompanyIds = getRelationIds(loser, "Linked Company");
        if (loserCompanyIds.length > 0 && !mergeUpdates["Linked Company"]) {
          mergeUpdates["Linked Company"] = { relation: loserCompanyIds.map(id => ({ id })) };
        }
      }
      // Merge campaign relations — collect ALL unique campaign IDs
      const loserCampaignIds = getRelationIds(loser, "Campaigns");
      if (loserCampaignIds.length > 0) {
        const existingCampaignIds = new Set(winnerCampaignIds);
        if (mergeUpdates["Campaigns"]) {
          for (const r of mergeUpdates["Campaigns"].relation) existingCampaignIds.add(r.id);
        }
        const newIds = loserCampaignIds.filter(id => !existingCampaignIds.has(id));
        if (newIds.length > 0) {
          const allIds = [...existingCampaignIds, ...newIds];
          mergeUpdates["Campaigns"] = { relation: allIds.map(id => ({ id })) };
        }
      }
    }

    // Also fix Full Name if winner is nameless but we got names from merge
    const winnerFullName = getTitle(winner);
    if (winnerFullName.includes("kickstarter.com") || winnerFullName.includes("::")) {
      const fn = mergeUpdates["First Name"]
        ? mergeUpdates["First Name"].rich_text[0].text.content
        : winnerFirstName;
      const ln = mergeUpdates["Last Name"]
        ? mergeUpdates["Last Name"].rich_text[0].text.content
        : winnerLastName;
      if (fn || ln) {
        const fullName = [fn, ln].filter(Boolean).join(" ");
        mergeUpdates["Full Name"] = { title: [{ text: { content: fullName } }] };
      }
    }

    // Apply merge updates to winner
    if (Object.keys(mergeUpdates).length > 0) {
      await update(winner.id, mergeUpdates);
      merged++;
    }

    // Archive losers
    for (const { page: loser } of losers) {
      await archivePage(loser.id);
      archived++;
      await sleep(350);
    }

    kept++;
    console.log(`  Apollo ${apolloId}: kept "${winnerName}" (score ${scored[0].score}), archived ${losers.length} dupes${Object.keys(mergeUpdates).length > 0 ? " + merged fields" : ""}`);
  }

  console.log(`\nPhase 1 results:`);
  console.log(`  Duplicate groups processed: ${kept}`);
  console.log(`  Records archived: ${archived}`);
  console.log(`  Winners with merged data: ${merged}`);
  console.log(`  People remaining: ~${people.length - archived}`);
}

// ========== PHASE 2: Archive nameless people ==========
async function phase2() {
  console.log("\n=== PHASE 2: Archive Remaining Nameless People ===\n");

  const people = await queryAll(PEOPLE_DB);
  console.log(`Fetched ${people.length} people.\n`);

  let archived = 0;
  let kept = 0;

  for (const p of people) {
    const firstName = getRichText(p, "First Name").trim();
    const lastName = getRichText(p, "Last Name").trim();
    const fullName = getTitle(p).trim();

    // Check if nameless — no first/last name AND full name looks like URL or is empty
    if (!firstName && !lastName) {
      if (!fullName || fullName.includes("kickstarter.com") || fullName.includes("::")) {
        await archivePage(p.id);
        archived++;
        console.log(`  Archived: "${fullName.slice(0, 80)}..." (no name)`);
        await sleep(350);
        continue;
      }
    }
    kept++;
  }

  console.log(`\nPhase 2 results:`);
  console.log(`  Archived (nameless): ${archived}`);
  console.log(`  Kept: ${kept}`);
}

// ========== Archive orphan people (no company AND no campaign) ==========
async function archiveOrphans() {
  console.log("\n=== Archive Orphan People (no company, no campaign) ===\n");

  const people = await queryAll(PEOPLE_DB);
  console.log(`Fetched ${people.length} people.\n`);

  let archived = 0;
  for (const p of people) {
    const companyIds = getRelationIds(p, "Linked Company");
    const campaignIds = getRelationIds(p, "Campaigns");
    if (companyIds.length === 0 && campaignIds.length === 0) {
      const name = getTitle(p);
      await archivePage(p.id);
      archived++;
      console.log(`  Archived: "${name}"`);
      await sleep(350);
    }
  }

  console.log(`\nArchived: ${archived}`);
  console.log(`Remaining: ${people.length - archived}`);
}

// ========== PHASE 3: Clean dirty data ==========
async function phase3() {
  console.log("\n=== PHASE 3: Clean Dirty Data ===\n");

  const people = await queryAll(PEOPLE_DB);
  console.log(`Fetched ${people.length} people.\n`);

  let linkedinCleared = 0;
  let dirtyNamesCleaned = 0;

  for (const p of people) {
    const updates: Record<string, any> = {};

    // Clear "not found" LinkedIn URLs
    const linkedin = getRichText(p, "Linkedin Person Url").trim();
    if (linkedin.toLowerCase() === "not found") {
      updates["Linkedin Person Url"] = { rich_text: [] };
      linkedinCleared++;
    }

    // Clean dirty names with separators (MagMirror pattern)
    const fullName = getTitle(p).trim();
    const separators = [" - ", " — ", " | ", " / "];
    for (const sep of separators) {
      if (fullName.includes(sep)) {
        const parts = fullName.split(sep);
        const cleanName = parts[0].trim();
        // Only clean if the first part looks like a name (not a URL)
        if (!cleanName.includes(".com") && !cleanName.includes("::") && cleanName.length < 50) {
          const nameParts = cleanName.split(/\s+/);
          const firstName = getRichText(p, "First Name").trim();
          const lastName = getRichText(p, "Last Name").trim();

          if (!firstName && nameParts[0]) {
            updates["First Name"] = { rich_text: [{ text: { content: nameParts[0] } }] };
          }
          if (!lastName && nameParts.slice(1).join(" ")) {
            updates["Last Name"] = { rich_text: [{ text: { content: nameParts.slice(1).join(" ") } }] };
          }
          updates["Full Name"] = { title: [{ text: { content: cleanName } }] };

          // Extract title if present
          const suffix = parts.slice(1).join(sep).trim();
          const atMatch = suffix.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
          if (atMatch && !getRichText(p, "Job Title").trim()) {
            updates["Job Title"] = { rich_text: [{ text: { content: atMatch[1].trim() } }] };
          }

          dirtyNamesCleaned++;
          break;
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      await update(p.id, updates);
      const name = updates["Full Name"] ? updates["Full Name"].title[0].text.content : getTitle(p);
      console.log(`  Cleaned: "${name}" — ${Object.keys(updates).join(", ")}`);
      await sleep(350);
    }
  }

  console.log(`\nPhase 3 results:`);
  console.log(`  "not found" LinkedIn cleared: ${linkedinCleared}`);
  console.log(`  Dirty names cleaned: ${dirtyNamesCleaned}`);
}

// ========== PHASE 4: Link companies ↔ campaigns by name ==========
async function phase4() {
  console.log("\n=== PHASE 4: Link Companies ↔ Campaigns ===\n");

  const [companies, campaigns] = await Promise.all([queryAll(COMPANY_DB), queryAll(CAMPAIGN_DB)]);
  console.log(`Companies: ${companies.length}, Campaigns: ${campaigns.length}\n`);

  // Build campaign name → id map
  const campaignByName = new Map<string, string>();
  const campaignNameNormalized = new Map<string, { id: string; name: string }>();
  for (const c of campaigns) {
    const name = getTitle(c);
    campaignByName.set(name, c.id);
    campaignNameNormalized.set(name.toLowerCase().trim(), { id: c.id, name });
  }

  let linked = 0;
  let alreadyLinked = 0;
  let noMatch = 0;
  const unmatched: string[] = [];

  for (const company of companies) {
    const existingCampaigns = getRelationIds(company, "Campaigns");
    if (existingCampaigns.length > 0) {
      alreadyLinked++;
      continue;
    }

    const companyName = getTitle(company);

    // Try exact match first
    let campaignId = campaignByName.get(companyName);

    // Try normalized match
    if (!campaignId) {
      const match = campaignNameNormalized.get(companyName.toLowerCase().trim());
      if (match) campaignId = match.id;
    }

    // Try substring match (company name contained in campaign name or vice versa)
    if (!campaignId) {
      const companyLower = companyName.toLowerCase();
      for (const [normName, { id }] of campaignNameNormalized) {
        if (normName.includes(companyLower) || companyLower.includes(normName)) {
          campaignId = id;
          break;
        }
      }
    }

    if (campaignId) {
      await update(company.id, {
        "Campaigns": { relation: [{ id: campaignId }] },
      });
      linked++;
      console.log(`  Linked: "${companyName}" → campaign`);
      await sleep(350);
    } else {
      noMatch++;
      unmatched.push(companyName);
    }
  }

  console.log(`\nPhase 4 results:`);
  console.log(`  Linked: ${linked}`);
  console.log(`  Already linked: ${alreadyLinked}`);
  console.log(`  No matching campaign: ${noMatch}`);
  if (unmatched.length > 0) {
    console.log(`  Unmatched companies:`);
    for (const n of unmatched) console.log(`    - "${n}"`);
  }
}

// ========== PHASE 5: Link people → companies ==========
async function phase5() {
  console.log("\n=== PHASE 5: Link People → Companies ===\n");

  const [people, companies, campaigns] = await Promise.all([
    queryAll(PEOPLE_DB),
    queryAll(COMPANY_DB),
    queryAll(CAMPAIGN_DB),
  ]);
  console.log(`People: ${people.length}, Companies: ${companies.length}, Campaigns: ${campaigns.length}\n`);

  // Build lookup maps
  const campaignToCompanyIds = new Map<string, string[]>();
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

    const campaignIds = getRelationIds(c, "Campaigns");
    for (const cid of campaignIds) {
      const existing = campaignToCompanyIds.get(cid) ?? [];
      existing.push(c.id);
      campaignToCompanyIds.set(cid, existing);
    }
  }

  let linked = 0;
  let alreadyLinked = 0;
  let noMatch = 0;
  let byCampaign = 0;
  let byEmail = 0;
  let byText = 0;

  for (const p of people) {
    const existing = getRelationIds(p, "Linked Company");
    if (existing.length > 0) {
      alreadyLinked++;
      continue;
    }

    const personName = getTitle(p);
    let companyId: string | undefined;
    let method = "";

    // Strategy 1: Infer company from campaign relation
    const campaignIds = getRelationIds(p, "Campaigns");
    for (const cid of campaignIds) {
      const companyIds = campaignToCompanyIds.get(cid);
      if (companyIds && companyIds.length > 0) {
        companyId = companyIds[0];
        method = "campaign";
        break;
      }
    }

    // Strategy 2: Match by email domain
    if (!companyId) {
      const email = getRichText(p, "Work Emails").trim();
      if (email) {
        const emailDomain = email.split("@")[1]?.toLowerCase();
        if (emailDomain && companyDomains.has(emailDomain)) {
          companyId = companyDomains.get(emailDomain)!.id;
          method = "email";
        }
      }
    }

    // Strategy 3: Match by company name in evidence/headline/match notes
    if (!companyId) {
      const headline = getRichText(p, "Headline").trim();
      const evidence = getRichText(p, "Evidence Summary").trim();
      const matchNotes = getRichText(p, "Match Notes").trim();
      const jobTitle = getRichText(p, "Job Title").trim();
      const searchText = `${headline} ${evidence} ${matchNotes} ${jobTitle}`.toLowerCase();

      for (const [cname, company] of companyNames) {
        if (cname.length < 4) continue;
        if (searchText.includes(cname)) {
          companyId = company.id;
          method = "text";
          break;
        }
      }
    }

    if (companyId) {
      await update(p.id, {
        "Linked Company": { relation: [{ id: companyId }] },
      });
      linked++;
      if (method === "campaign") byCampaign++;
      else if (method === "email") byEmail++;
      else if (method === "text") byText++;
      console.log(`  Linked: "${personName}" → company (via ${method})`);
      await sleep(350);
    } else {
      noMatch++;
      console.log(`  NO MATCH: "${personName}"`);
    }
  }

  console.log(`\nPhase 5 results:`);
  console.log(`  Linked: ${linked} (campaign: ${byCampaign}, email: ${byEmail}, text: ${byText})`);
  console.log(`  Already linked: ${alreadyLinked}`);
  console.log(`  No match: ${noMatch}`);
}

// ========== PHASE 6: Link people → campaigns ==========
async function phase6() {
  console.log("\n=== PHASE 6: Link People → Campaigns ===\n");

  const [people, companies] = await Promise.all([
    queryAll(PEOPLE_DB),
    queryAll(COMPANY_DB),
  ]);
  console.log(`People: ${people.length}, Companies: ${companies.length}\n`);

  // Build company ID → campaign IDs map
  const companyToCampaignIds = new Map<string, string[]>();
  for (const c of companies) {
    companyToCampaignIds.set(c.id, getRelationIds(c, "Campaigns"));
  }

  let linked = 0;
  let alreadyLinked = 0;
  let noMatch = 0;

  for (const p of people) {
    const existingCampaigns = getRelationIds(p, "Campaigns");
    if (existingCampaigns.length > 0) {
      alreadyLinked++;
      continue;
    }

    const personName = getTitle(p);

    // Inherit campaigns from linked company
    const companyIds = getRelationIds(p, "Linked Company");
    const inheritedCampaignIds = new Set<string>();

    for (const cid of companyIds) {
      const campaigns = companyToCampaignIds.get(cid) ?? [];
      for (const camId of campaigns) inheritedCampaignIds.add(camId);
    }

    if (inheritedCampaignIds.size > 0) {
      await update(p.id, {
        "Campaigns": { relation: [...inheritedCampaignIds].map(id => ({ id })) },
      });
      linked++;
      console.log(`  Linked: "${personName}" → ${inheritedCampaignIds.size} campaign(s) (via company)`);
      await sleep(350);
    } else {
      noMatch++;
    }
  }

  console.log(`\nPhase 6 results:`);
  console.log(`  Linked (via company): ${linked}`);
  console.log(`  Already linked: ${alreadyLinked}`);
  console.log(`  No match (no company or company has no campaign): ${noMatch}`);
}

// ========== FINAL AUDIT ==========
async function finalAudit() {
  console.log("\n=== FINAL DATA QUALITY AUDIT ===\n");

  const [people, companies, campaigns] = await Promise.all([
    queryAll(PEOPLE_DB),
    queryAll(COMPANY_DB),
    queryAll(CAMPAIGN_DB),
  ]);

  console.log(`Active records: People ${people.length}, Companies ${companies.length}, Campaigns ${campaigns.length}\n`);

  // People checks
  let nameless = 0;
  let noCompany = 0;
  let noCampaign = 0;
  let noEmail = 0;
  let notFoundLinkedin = 0;
  const apolloIds = new Map<string, number>();

  for (const p of people) {
    const fn = getRichText(p, "First Name").trim();
    const ln = getRichText(p, "Last Name").trim();
    if (!fn && !ln) nameless++;
    if (getRelationIds(p, "Linked Company").length === 0) noCompany++;
    if (getRelationIds(p, "Campaigns").length === 0) noCampaign++;
    if (!getRichText(p, "Work Emails").trim()) noEmail++;
    const li = getRichText(p, "Linkedin Person Url").trim();
    if (li.toLowerCase() === "not found") notFoundLinkedin++;
    const aid = getRichText(p, "Apollo Person ID").trim();
    if (aid) apolloIds.set(aid, (apolloIds.get(aid) ?? 0) + 1);
  }

  let dupApollo = 0;
  for (const [, count] of apolloIds) {
    if (count > 1) dupApollo++;
  }

  // Company checks
  let companyNoPeople = 0;
  let companyNoCampaign = 0;
  for (const c of companies) {
    if (getRelationIds(c, "All People").length === 0) companyNoPeople++;
    if (getRelationIds(c, "Campaigns").length === 0) companyNoCampaign++;
  }

  // Campaign checks
  let campaignNoPeople = 0;
  let campaignNoCompany = 0;
  for (const c of campaigns) {
    if (getRelationIds(c, "People").length === 0) campaignNoPeople++;
    if (getRelationIds(c, "Companies").length === 0) campaignNoCompany++;
  }

  console.log("PEOPLE:");
  console.log(`  Total: ${people.length}`);
  console.log(`  Nameless (no First/Last Name): ${nameless} ${nameless === 0 ? "✓" : "⚠"}`);
  console.log(`  Duplicate Apollo IDs: ${dupApollo} ${dupApollo === 0 ? "✓" : "⚠"}`);
  console.log(`  No Linked Company: ${noCompany} / ${people.length} ${noCompany === 0 ? "✓" : "⚠"}`);
  console.log(`  No Campaigns: ${noCampaign} / ${people.length} ${noCampaign === 0 ? "✓" : "⚠"}`);
  console.log(`  No Work Email: ${noEmail} / ${people.length}`);
  console.log(`  "not found" LinkedIn: ${notFoundLinkedin} ${notFoundLinkedin === 0 ? "✓" : "⚠"}`);

  console.log("\nCOMPANIES:");
  console.log(`  Total: ${companies.length}`);
  console.log(`  No All People: ${companyNoPeople} / ${companies.length} ${companyNoPeople === 0 ? "✓" : "⚠"}`);
  console.log(`  No Campaigns: ${companyNoCampaign} / ${companies.length} ${companyNoCampaign === 0 ? "✓" : "⚠"}`);

  console.log("\nCAMPAIGNS:");
  console.log(`  Total: ${campaigns.length}`);
  console.log(`  No People: ${campaignNoPeople} / ${campaigns.length} ${campaignNoPeople === 0 ? "✓" : "⚠"}`);
  console.log(`  No Companies: ${campaignNoCompany} / ${campaigns.length} ${campaignNoCompany === 0 ? "✓" : "⚠"}`);

  // Orphan details
  if (noCompany > 0) {
    console.log(`\nPeople without company:`);
    for (const p of people) {
      if (getRelationIds(p, "Linked Company").length === 0) {
        console.log(`  - "${getTitle(p)}" (campaigns: ${getRelationIds(p, "Campaigns").length})`);
      }
    }
  }
}

// ========== MAIN ==========
const phase = process.argv[2];
if (!phase) {
  console.log("Usage: tsx src/cleanup-pipeline.ts <phase>");
  console.log("Phases: phase1, phase2, phase3, phase4, phase5, phase6, audit");
  process.exit(1);
}

switch (phase) {
  case "phase1": await phase1(); break;
  case "phase2": await phase2(); break;
  case "archive-orphans": await archiveOrphans(); break;
  case "phase3": await phase3(); break;
  case "phase4": await phase4(); break;
  case "phase5": await phase5(); break;
  case "phase6": await phase6(); break;
  case "audit": await finalAudit(); break;
  default: console.log(`Unknown phase: ${phase}`); process.exit(1);
}
