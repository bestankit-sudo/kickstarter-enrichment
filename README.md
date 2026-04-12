# Kickstarter Enrichment Pipeline

A precision outreach-path discovery system for Kickstarter campaigns. Finds the best reachable contact (LinkedIn profile, verified email, or company channel) for each campaign company.

Built with TypeScript, Apollo, OpenAI GPT 5.4, Brave Search, and Notion.

## Quick Start

### 1. Install

```bash
git clone <repo-url>
cd kickstarter-enrichment
npm install
```

### 2. Configure API Keys

```bash
cp .env.example .env
```

Edit `.env` and add your keys:
- **Notion** — [Create an integration](https://www.notion.so/my-integrations), share a parent page with it
- **Apollo** — [Sign up](https://app.apollo.io/) (Basic plan for People Search)
- **OpenAI** — [Get API key](https://platform.openai.com/api-keys)
- **Brave Search** — [Get API key](https://brave.com/search/api/)

### 3. Set Up Notion Databases

```bash
npm run setup
```

This creates 3 interconnected databases in your Notion workspace:
- **Kickstarter Campaign Outreach** — your source data (add campaigns here)
- **Company Enriched** — company profiles, socials, emails
- **People Enriched** — contact persons with LinkedIn and verified emails

### 4. Add Your Campaigns

Open the Kickstarter Campaign Outreach database in Notion and add rows:
- **Campaign Name** — the Kickstarter project name
- **Kickstarter URL** — full Kickstarter project URL
- **External Link** — company website URL (if known)
- **Founder / Creator** — founder name(s)

### 5. Run the Pipeline

```bash
# Stage 1: Scrape websites, extract socials and emails
npm run enrich:companies

# Stage 2: Find people via Apollo + AI scoring
npm run enrich:people

# Stage 2b: Upgrade SERP-found candidates with full Apollo profiles
npx tsx src/index.ts reveal-serp
```

## How It Works

The pipeline uses a cost-optimized multi-pass approach:

1. **Search is free** — Apollo search returns metadata at no cost
2. **AI decides who to reveal** — GPT 5.4 scores candidates before spending credits
3. **Only reveal the best** — max 2 reveals per company per pass
4. **9 AI checkpoints** — validate, score, quality-gate, and merge-check every data point

See [PROCESS.md](PROCESS.md) for the complete technical documentation.

## Commands

| Command | Description |
|---------|-------------|
| `npm run setup` | Create Notion databases (first time only) |
| `npm run enrich:companies` | Stage 1: website scraping + Apollo org resolution |
| `npm run enrich:people` | Stage 2: person discovery + AI scoring |
| `npm run enrich:people -- --force` | Re-process all records including done |
| `npm run enrich:people -- --limit 5` | Process first 5 companies only |
| `npm run enrich:people -- --dry-run` | Preview without making API calls |
| `npx tsx src/index.ts reveal-serp` | Reveal SERP candidates via Apollo |

## Architecture

```
Kickstarter Campaign Outreach (your input)
        ↕ Source Campaign
Company Enriched (Stage 1 output)
        ↕ Company + Best Person
People Enriched (Stage 2 output)
        ↕ Source Campaign
```

## Cost

For 51 companies:
- **Apollo credits**: ~60 reveals (optimized from ~200)
- **OpenAI**: ~$3
- **Brave Search**: ~200 queries
