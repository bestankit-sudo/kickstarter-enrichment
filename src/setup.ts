import { Client } from "@notionhq/client";
import { config as loadDotenv } from "dotenv";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ask = async (rl: readline.Interface, question: string): Promise<string> => {
  const answer = await rl.question(question);
  return answer.trim();
};

async function setup() {
  console.log("\n🚀 Kickstarter Enrichment Pipeline — Setup\n");
  console.log("This will create 3 interconnected Notion databases for the enrichment pipeline.\n");

  const rl = readline.createInterface({ input, output });

  try {
    // Load existing .env if present
    loadDotenv();

    const notionKey = await ask(rl, "Notion API Key (Integration Token): ");
    if (!notionKey) {
      console.error("❌ Notion API key is required.");
      return;
    }

    const parentPageId = await ask(rl, "Notion Parent Page ID (where to create databases): ");
    if (!parentPageId) {
      console.error("❌ Parent page ID is required. Create a page in Notion and copy its ID from the URL.");
      return;
    }

    const notion = new Client({ auth: notionKey });

    console.log("\n📦 Creating databases...\n");

    // ─── DB1: Kickstarter Campaign Outreach (source) ───
    console.log("  1/3 Creating Kickstarter Campaign Outreach...");
    const db1 = await notion.databases.create({
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: "Kickstarter Campaign Outreach" } }],
      properties: {
        "Campaign Name": { title: {} },
        "Kickstarter URL": { url: {} },
        "External Link": { url: {} },
        "Founder / Creator": { rich_text: {} },
        "Country / Location": { rich_text: {} },
        "Backers": { number: {} },
        "Amount Pledged": { number: {} },
        "Currency": {
          select: {
            options: [
              { name: "USD", color: "green" },
              { name: "GBP", color: "blue" },
              { name: "EUR", color: "yellow" },
              { name: "CAD", color: "orange" },
              { name: "AUD", color: "purple" },
            ],
          },
        },
        "Internal Category": { multi_select: { options: [] } },
        "Direct Competitor": { checkbox: {} },
        "Research Notes": { rich_text: {} },
      },
    });
    console.log(`  ✓ Created: ${db1.id}`);

    // ─── DB2: Company Enriched ───
    console.log("  2/3 Creating Company Enriched...");
    const db2 = await notion.databases.create({
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: "Company Enriched" } }],
      properties: {
        "Campaign Name": { title: {} },
        "Source Campaign": { relation: { database_id: db1.id, single_property: {} } },
        "Company Name": { rich_text: {} },
        "Company Domain": { url: {} },
        "Company Description": { rich_text: {} },
        "Company Country": { rich_text: {} },
        "LinkedIn Company URL": { rich_text: {} },
        "X URL": { rich_text: {} },
        "Instagram URL": { rich_text: {} },
        "Facebook URL": { rich_text: {} },
        "YouTube URL": { rich_text: {} },
        "TikTok URL": { rich_text: {} },
        "Generic Business Email": { rich_text: {} },
        "Contact Form URL": { url: {} },
        "Company Phone": { rich_text: {} },
        "Industry": { rich_text: {} },
        "Founded Year": { number: {} },
        "Total Funding": { rich_text: {} },
        "Funding Stage": { rich_text: {} },
        "Keywords": { rich_text: {} },
        "Employee Count": { number: {} },
        "Apollo Organisation ID": { rich_text: {} },
        "External Link": { rich_text: {} },
        "Enrichment Status": {
          select: {
            options: [
              { name: "done", color: "green" },
              { name: "partial", color: "yellow" },
              { name: "failed", color: "red" },
              { name: "needs_review", color: "orange" },
              { name: "stale", color: "gray" },
            ],
          },
        },
        "Match Confidence": {
          select: {
            options: [
              { name: "high", color: "green" },
              { name: "medium", color: "yellow" },
              { name: "low", color: "red" },
            ],
          },
        },
        "Best Outreach Path": {
          select: {
            options: [
              { name: "linkedin_person", color: "green" },
              { name: "work_email", color: "blue" },
              { name: "company_email", color: "yellow" },
              { name: "linkedin_person_review", color: "orange" },
              { name: "social_dm", color: "purple" },
              { name: "contact_form", color: "gray" },
            ],
          },
        },
        "Primary Person Confidence": {
          select: {
            options: [
              { name: "high", color: "green" },
              { name: "medium", color: "yellow" },
              { name: "low", color: "red" },
            ],
          },
        },
        "Company Outreach Readiness": {
          select: {
            options: [
              { name: "ready_person", color: "green" },
              { name: "ready_company_channel", color: "blue" },
              { name: "review", color: "yellow" },
              { name: "blocked", color: "red" },
            ],
          },
        },
        "Source Notes": { rich_text: {} },
        "Sources Used": { rich_text: {} },
        "Last Checked At": { date: {} },
      },
    });
    console.log(`  ✓ Created: ${db2.id}`);

    // ─── DB3: People Enriched ───
    console.log("  3/3 Creating People Enriched...");
    const db3 = await notion.databases.create({
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: "People Enriched" } }],
      properties: {
        "Full Name": { title: {} },
        "Company": { relation: { database_id: db2.id, single_property: {} } },
        "Source Campaign": { relation: { database_id: db1.id, single_property: {} } },
        "First Name": { rich_text: {} },
        "Last Name": { rich_text: {} },
        "Headline": { rich_text: {} },
        "Linkedin Person Url": { rich_text: {} },
        "Work Emails": { rich_text: {} },
        "Email Status": { rich_text: {} },
        "Job Title": { rich_text: {} },
        "Apollo Person ID": { rich_text: {} },
        "Discovery Method": {
          select: {
            options: [
              { name: "apollo", color: "green" },
              { name: "serp_fallback", color: "orange" },
              { name: "manual", color: "blue" },
              { name: "founder_direct", color: "purple" },
            ],
          },
        },
        "Candidate Rank": { number: {} },
        "Is Primary Candidate": { checkbox: {} },
        "Match Confidence": {
          select: {
            options: [
              { name: "high", color: "green" },
              { name: "medium", color: "yellow" },
              { name: "low", color: "red" },
            ],
          },
        },
        "Evidence Summary": { rich_text: {} },
        "Match Notes": { rich_text: {} },
        "Enrich Status": {
          select: {
            options: [
              { name: "done", color: "green" },
              { name: "partial", color: "yellow" },
              { name: "failed", color: "red" },
              { name: "needs_review", color: "orange" },
              { name: "skipped", color: "gray" },
              { name: "stale", color: "blue" },
            ],
          },
        },
        "City": { rich_text: {} },
        "Country": { rich_text: {} },
        "Twitter X Url": { rich_text: {} },
        "Last Enriched At": { rich_text: {} },
        "Last Error": { rich_text: {} },
      },
    });
    console.log(`  ✓ Created: ${db3.id}`);

    // ─── Add Best Person relation (DB2 → DB3, needs DB3 ID) ───
    console.log("\n  Linking Best Person relation...");
    await notion.databases.update({
      database_id: db2.id,
      properties: {
        "Best Person": { relation: { database_id: db3.id, single_property: {} } },
      },
    });
    console.log("  ✓ Best Person linked");

    // ─── Write to .env ───
    const envPath = ".env";
    let envContent = "";
    if (existsSync(envPath)) {
      envContent = readFileSync(envPath, "utf8");
    }

    const envLines = [
      `NOTION_API_KEY=${notionKey}`,
      `NOTION_KICKSTARTER_DB_ID=${db1.id.replace(/-/g, "")}`,
      `NOTION_COMPANY_ENRICHED_DB_ID=${db2.id.replace(/-/g, "")}`,
      `NOTION_PEOPLE_ENRICHED_DB_ID=${db3.id.replace(/-/g, "")}`,
    ];

    // Append or create .env
    const newEnvContent = envContent
      ? `${envContent}\n# — Generated by setup —\n${envLines.join("\n")}\n`
      : `${envLines.join("\n")}\n`;

    writeFileSync(envPath, newEnvContent);

    console.log("\n✅ Setup complete!\n");
    console.log("Database IDs written to .env:\n");
    for (const line of envLines) {
      console.log(`  ${line}`);
    }
    console.log("\nNext steps:");
    console.log("  1. Add your API keys to .env (see .env.example)");
    console.log("  2. Add Kickstarter campaigns to the Campaign Outreach database");
    console.log("  3. Run: npm run enrich:companies");
    console.log("  4. Run: npm run enrich:people");
    console.log("  5. Run: npx tsx src/index.ts reveal-serp\n");
  } finally {
    rl.close();
  }
}

setup().catch((error) => {
  console.error("Setup failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
