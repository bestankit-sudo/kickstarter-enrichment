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
  console.log("\n  Kickstarter Enrichment Pipeline — Setup\n");
  console.log("This will create 4 interconnected Notion databases for the enrichment pipeline.\n");

  const rl = readline.createInterface({ input, output });

  try {
    loadDotenv();

    const notionKey = await ask(rl, "Notion API Key (Integration Token): ");
    if (!notionKey) {
      console.error("Notion API key is required.");
      return;
    }

    const parentPageId = await ask(rl, "Notion Parent Page ID (where to create databases): ");
    if (!parentPageId) {
      console.error("Parent page ID is required. Create a page in Notion and copy its ID from the URL.");
      return;
    }

    const notion = new Client({ auth: notionKey });

    console.log("\nCreating databases...\n");

    // ─── DB1: Kickstarter Campaign Outreach (source) ───
    console.log("  1/4 Creating Kickstarter Campaign Outreach...");
    const db1 = await notion.databases.create({
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: "Kickstarter Campaign Outreach" } }],
      properties: {
        "Campaign Name": { title: {} },
        "Kickstarter URL": { url: {} },
        "External Link": { url: {} },
        "Country / Location": { rich_text: {} },
        "Kickstarter Category": { rich_text: {} },
        "Genre": { rich_text: {} },
        "Backers": { number: {} },
        "Amount Pledged": { number: { format: "number_with_commas" } },
        "Currency": {
          select: {
            options: [
              { name: "USD", color: "blue" },
              { name: "GBP", color: "default" },
              { name: "EUR", color: "orange" },
              { name: "CAD", color: "gray" },
              { name: "AUD", color: "brown" },
              { name: "HKD", color: "green" },
              { name: "Other", color: "red" },
            ],
          },
        },
        "Campaign Start Date": { date: {} },
        "Project Last Updated": { date: {} },
        "Internal Category": { multi_select: { options: [] } },
        "Direct Competitor": { checkbox: {} },
        "Research Notes": { rich_text: {} },
      },
    });
    console.log(`  Created: ${db1.id}`);

    // ─── DB2: Company Enriched ───
    console.log("  2/4 Creating Company Enriched...");
    const db2 = await notion.databases.create({
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: "Company Enriched" } }],
      properties: {
        "Campaign Name": { title: {} },
        "Campaigns": { relation: { database_id: db1.id, dual_property: { synced_property_name: "Companies" } } },
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
      },
    });
    console.log(`  Created: ${db2.id}`);

    // ─── DB3: People Enriched ───
    console.log("  3/4 Creating People Enriched...");
    const db3 = await notion.databases.create({
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: "People Enriched" } }],
      properties: {
        "Full Name": { title: {} },
        "Linked Company": { relation: { database_id: db2.id, dual_property: { synced_property_name: "All People" } } },
        "Campaigns": { relation: { database_id: db1.id, dual_property: { synced_property_name: "People" } } },
        "First Name": { rich_text: {} },
        "Last Name": { rich_text: {} },
        "Headline": { rich_text: {} },
        "Linkedin Person Url": { rich_text: {} },
        "Work Emails": { rich_text: {} },
        "Email Status": { rich_text: {} },
        "Job Title": { rich_text: {} },
        "Apollo Person ID": { rich_text: {} },
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
      },
    });
    console.log(`  Created: ${db3.id}`);

    // ─── DB4: Extractions ───
    console.log("  4/4 Creating Extractions...");
    const db4 = await notion.databases.create({
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: "Extractions" } }],
      properties: {
        "Extraction": { title: {} },
        "Type": {
          select: {
            options: [
              { name: "company", color: "blue" },
              { name: "people", color: "purple" },
            ],
          },
        },
        "Source": {
          select: {
            options: [
              { name: "website_scrape", color: "green" },
              { name: "apollo_reveal", color: "orange" },
              { name: "apollo_search", color: "yellow" },
              { name: "apollo_org", color: "brown" },
              { name: "brave_serp", color: "blue" },
              { name: "manual", color: "gray" },
            ],
          },
        },
        "Status": {
          select: {
            options: [
              { name: "raw", color: "default" },
              { name: "accepted", color: "green" },
              { name: "rejected", color: "red" },
              { name: "merged", color: "yellow" },
            ],
          },
        },
        "Extracted At": { date: {} },
        "Raw Data": { rich_text: {} },
        "Source Query": { rich_text: {} },
        "Source Notes": { rich_text: {} },
        "AI Validation": { rich_text: {} },
        "Credits Used": { number: {} },
        "Company": { relation: { database_id: db2.id, dual_property: { synced_property_name: "Extractions" } } },
        "Person": { relation: { database_id: db3.id, dual_property: { synced_property_name: "Extractions" } } },
        "Campaign": { relation: { database_id: db1.id, single_property: {} } },
      },
    });
    console.log(`  Created: ${db4.id}`);

    // ─── Add Best Person relation (DB2 → DB3, needs DB3 ID) ───
    console.log("\n  Linking Best Person relation...");
    await notion.databases.update({
      database_id: db2.id,
      properties: {
        "Best Person": { relation: { database_id: db3.id, single_property: {} } },
      },
    });
    console.log("  Best Person linked");

    // ─── Add People Count rollup (DB2, counts All People) ───
    console.log("  Adding People Count rollup...");
    // Need to find the All People property ID first
    const db2Schema = await notion.databases.retrieve({ database_id: db2.id });
    const allPeopleProperty = (db2Schema as any).properties["All People"];
    if (allPeopleProperty) {
      await notion.databases.update({
        database_id: db2.id,
        properties: {
          "People Count": {
            rollup: {
              relation_property_name: "All People",
              rollup_property_name: "Full Name",
              function: "count",
            },
          },
        },
      });
      console.log("  People Count rollup added");
    }

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
      `NOTION_EXTRACTIONS_DB_ID=${db4.id.replace(/-/g, "")}`,
    ];

    const newEnvContent = envContent
      ? `${envContent}\n# — Generated by setup —\n${envLines.join("\n")}\n`
      : `${envLines.join("\n")}\n`;

    writeFileSync(envPath, newEnvContent);

    console.log("\nSetup complete!\n");
    console.log("Database IDs written to .env:\n");
    for (const line of envLines) {
      console.log(`  ${line}`);
    }
    console.log("\nDatabase structure:");
    console.log("  Campaign Outreach ←→ Company Enriched (dual: Campaigns / Companies)");
    console.log("  Campaign Outreach ←→ People Enriched  (dual: Campaigns / People)");
    console.log("  Company Enriched  ←→ People Enriched  (dual: All People / Linked Company)");
    console.log("  Company Enriched  ←→ Extractions      (dual: Extractions / Company)");
    console.log("  People Enriched   ←→ Extractions      (dual: Extractions / Person)");
    console.log("  Company Enriched   → People Enriched  (one-way: Best Person)");
    console.log("\nNext steps:");
    console.log("  1. Add your API keys to .env (Apollo, OpenAI, Brave Search)");
    console.log("  2. Run: npm run scrape:kickstarter   (Stage 0: populate campaigns)");
    console.log("  3. Run: npm run enrich:companies      (Stage 1: website scrape + Apollo org)");
    console.log("  4. Run: npm run enrich:people          (Stage 2: person discovery)");
    console.log("  5. Run: npx tsx src/fix-names-and-dedup.ts fix-names && npx tsx src/fix-names-and-dedup.ts dedup");
    console.log("  6. Run: npx tsx src/cleanup-pipeline.ts audit\n");
  } finally {
    rl.close();
  }
}

setup().catch((error) => {
  console.error("Setup failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
