# Kickstarter Enrichment Pipeline

A precision outreach-path discovery system for Kickstarter campaigns. Finds the best reachable contact (LinkedIn profile, verified email, or company channel) for each campaign company.

Built with TypeScript, Apollo, OpenAI GPT 5.4, Brave Search, and Notion.

Prioritizes **precision over recall** and **cost control over breadth**. AI validates every data point before writing to Notion. Apollo credits are spent only on candidates the AI deems worth revealing.

---

## Quick Start

### 1. Install

```bash
git clone https://github.com/bestankit-sudo/kickstarter-enrichment.git
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

Creates 3 interconnected databases in your Notion workspace:
- **Kickstarter Campaign Outreach** — your source data (add campaigns here)
- **Company Enriched** — company profiles, socials, emails, industry, funding
- **People Enriched** — contact persons with LinkedIn, verified emails, job titles

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

---

## Commands

| Command | Description |
|---------|-------------|
| `npm run setup` | Create Notion databases (first time only) |
| `npm run enrich:companies` | Stage 1: website scraping + Apollo org resolution |
| `npm run enrich:people` | Stage 2: person discovery + AI scoring |
| `npm run enrich:people -- --force` | Re-process all records including done/partial |
| `npm run enrich:people -- --limit 5` | Process first 5 companies only |
| `npm run enrich:people -- --dry-run` | Preview without making API calls |
| `npx tsx src/index.ts reveal-serp` | Reveal SERP candidates via Apollo |

---

## Architecture

```
Kickstarter Campaign Outreach (read-only source)
        ↕ Source Campaign relation
Company Enriched (Stage 1 + Apollo org backfill)
        ↕ Company relation + Best Person relation
People Enriched (Stage 2 — person discovery)
        ↕ Source Campaign relation (back to Kickstarter)
```

All 3 databases are bidirectionally linked. Clicking any relation navigates between tables.

### API Stack

| API | Purpose | Cost Model |
|-----|---------|-----------|
| Apollo People Search | Find candidates by domain/name/title | Free (search metadata) |
| Apollo People Reveal | Get full profile (LinkedIn, email, name) | 1 credit per person |
| Apollo Org Enrichment | Resolve company by name/domain | 1 credit per org |
| OpenAI GPT 5.4 | 9 AI decision points throughout pipeline | ~$0.01-0.05/company |
| Brave Search | SERP fallback for LinkedIn discovery | Per query |
| Notion API | Read/write all 3 databases | Free |

---

## Stage 1: Company Enrichment

For each Kickstarter campaign with an External Link, scrape the company website and extract contact channels.

```
For each Kickstarter campaign:

1. Extract domain from External Link
2. Check domain against blocklist (facebook.com, amazon.com, indiegogo.com, etc.)

   Domain is valid:
   3a. Scrape website HTML
       → Extract social URLs (LinkedIn, X, Instagram, Facebook, YouTube, TikTok)
       → Extract business email (prefers domain-matching emails)
   3b. If scrape fails (403, timeout, dead domain):
       → Apollo Org Search by campaign name (paid, 1 credit)
       → If resolved: write Apollo org ID + domain to Company Enriched

   No domain or blocked domain:
   3c. Apollo Org Search by campaign name (paid, 1 credit)
       → If resolved: write Apollo org ID + domain

4. Write to Company Enriched with Source Campaign relation
```

No AI involved in Stage 1. All extraction is regex-based.

---

## Stage 2: People Enrichment

For each enriched company, find the best person to contact using a cost-optimized multi-pass approach.

### Cost optimization principles

1. **Search is free, reveal is paid** — Apollo search returns metadata at no cost. Only reveal candidates the AI says are worth it.
2. **Sequential passes with early exit** — Stop searching when good enough results found.
3. **Deduplicate before reveal** — Same person from multiple searches = 1 reveal, not 3.
4. **Medium confidence stops escalation** — A medium-confidence founder is better than searching for random operators.
5. **Stale guard** — Don't re-enrich partial records within 7 days unless `--force`.

### Process flow (per company)

```
┌─────────────────────────────────────────────────────────┐
│ STAGE 2 PIPELINE                                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ① AI: Normalize founder names (GPT 5.4)                │
│                                                         │
│  ② SEARCH (FREE — no credits)                           │
│     Pass A1: domain + founder name + founder titles     │
│     Pass A2: company name + founder name (if A1 empty)  │
│     Pass A3: founder name + company keyword (if A2 empty)│
│     → Deduplicate all results by Apollo Person ID       │
│                                                         │
│  ③ AI: Preliminary score on search metadata (GPT 5.4)   │
│     "5 results → 2 worth revealing"                     │
│     Max reveals: 2 per pass                             │
│                                                         │
│  ④ REVEAL (PAID — 1 credit each)                        │
│     Only reveal candidates AI approved                  │
│                                                         │
│  ⑤ AI: Validate each revealed person (GPT 5.4)          │
│     "Does this person actually work at target company?" │
│                                                         │
│  ⑥ AI: Score & rank validated candidates (GPT 5.4)      │
│     high / medium / low confidence + evidence summary   │
│                                                         │
│  ┌─ Has medium+ confidence? → Skip Pass B, write ───┐   │
│  └─ No → Continue ──────────────────────────────────┘   │
│                                                         │
│  ⑦ Pass B: Operator titles (partnerships, marketing, BD)│
│     Same flow: search → prelim score → reveal → validate│
│                                                         │
│  ⑧ Pass C: Apollo Org Search → resolve domain → retry  │
│                                                         │
│  ⑨ Pass D: Brave Search SERP fallback                   │
│     Max confidence from SERP: medium                    │
│                                                         │
│  ⑩ BEFORE WRITING — 4 AI gates:                         │
│     • Data quality gate (URLs, emails, real person?)    │
│     • Rebrand detection (domain mismatch?)              │
│     • Merge decision (improvement or duplicate?)        │
│     • Outreach brief (primary candidates only)          │
│                                                         │
│  ⑪ AI: Company intelligence summary (GPT 5.4)           │
│                                                         │
│  ⑫ WRITE TO NOTION with relations                       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Stage 2b: Reveal SERP Candidates

After Stage 2, SERP-found candidates have LinkedIn URLs but no email/headline/city. The `reveal-serp` command reveals them through Apollo using their LinkedIn URL (1 credit each).

---

## 9 AI Decision Points

| # | Function | Input | Output | Cost Impact |
|---|----------|-------|--------|-------------|
| 1 | Founder name normalization | Raw "Founder / Creator" text | Parsed name array | Improves search accuracy |
| 2 | Preliminary score | Search metadata (free) | Who to reveal (max 2) | **Saves 60-80% of credits** |
| 3 | Candidate validation | Person + employment history | Works here? yes/no | Prevents junk data |
| 4 | Candidate scoring | All validated candidates | Ranked with evidence | Determines primary |
| 5 | Data quality gate | URLs + emails + names | Pass/fail + issues | Prevents bad data |
| 6 | Rebrand detection | Domain A vs Domain B | Same company? | Prevents wrong searches |
| 7 | Merge decision | Existing vs incoming | Write/skip/merge | Prevents duplicates |
| 8 | Outreach brief | Primary candidate + campaign | 1-2 sentence talking point | Saves outreach prep |
| 9 | Company summary | Apollo org data | 2-3 sentence intelligence | Contextualizes company |

---

## Apollo API Usage

### Endpoints

| Endpoint | Purpose | Cost |
|----------|---------|------|
| `POST /api/v1/mixed_people/api_search` | Search by domain/name/title | **Free** |
| `POST /api/v1/people/match` | Reveal full profile (by ID or LinkedIn URL) | **1 credit** |
| `POST /api/v1/organizations/enrich` | Resolve company | **1 credit** |

### Search parameters

| Parameter | What we send | When |
|-----------|-------------|------|
| `q_organization_domains` | Company domain (blocklist-filtered) | Pass A1, B |
| `q_organization_name` | Company name | Pass A2, B (no valid domain) |
| `q_person_name` | Founder's full name | Pass A1, A2, A3 |
| `person_titles` | Founder/CEO titles or operator titles | Pass A, B |
| `person_seniorities` | founder, owner, c_suite | Pass A |
| `organization_ids` | Apollo org ID | Pass C |

### Domain blocklist

Prevents searching marketplace/social domains that return wrong people:
`facebook.com, amazon.com, indiegogo.com, igg.me, kickstarter.com, backerkit.com, shopify.com, etsy.com, ...`

### Data extracted from reveal

**Person:** name, title, headline, linkedin_url, email, email_status, twitter_url, city, country, seniority, employment_history

**Company (free with reveal):** name, linkedin_url, primary_domain, short_description, industry, employee_count, founded_year, total_funding, funding_stage, phone, keywords

---

## Notion Database Schema

### Kickstarter Campaign Outreach (read-only source)
Campaign Name, Kickstarter URL, External Link, Founder / Creator, Country / Location, Backers, Amount Pledged, Currency, Internal Category

### Company Enriched
Campaign Name, **Source Campaign** (→ Kickstarter), **Best Person** (→ People), Company Name, Company Domain, Company Description, LinkedIn Company URL, socials (X, Instagram, Facebook, YouTube, TikTok), Generic Business Email, Contact Form URL, Company Phone, Industry, Founded Year, Total Funding, Funding Stage, Keywords, Employee Count, Apollo Organisation ID, Best Outreach Path, Primary Person Confidence, Company Outreach Readiness, Enrichment Status, Match Confidence, Source Notes, Sources Used, Last Checked At

### People Enriched
**Full Name** (title), **Company** (→ Company Enriched), **Source Campaign** (→ Kickstarter), First Name, Last Name, Headline, LinkedIn Person URL, Work Emails, Email Status, Job Title, Apollo Person ID, Discovery Method, Candidate Rank, Is Primary Candidate, Match Confidence, Evidence Summary, Match Notes, City, Country, Twitter X URL, Enrich Status, Last Enriched At, Last Error

---

## Cost Model

### Per company (estimated)

| Step | Credits |
|------|---------|
| Apollo search (1-3 passes) | **Free** |
| AI preliminary score | ~$0.003 |
| Apollo reveal (1-2 people) | **1-2 credits** |
| AI validate + score + quality gate | ~$0.01 |
| Apollo Pass C org search (rare) | **0-1 credit** |
| AI merge + outreach + summary | ~$0.005 |

### For 51 companies

| | Before | After optimization |
|---|---|---|
| Apollo reveals | ~200 | **~60** |
| OpenAI cost | ~$2 | ~$3 |

**70% fewer Apollo credits at ~$1 more OpenAI.**

---

## Safeguards

**Stale guard** — Partial/needs_review records skipped if enriched within 7 days. Override with `--force`.

**Domain blocklist** — 15+ domains blocked before Apollo search. Prevents revealing Facebook employees when the External Link was a Facebook page.

**AI merge decision** — Before every write, GPT 5.4 compares existing vs incoming: write if improvement, skip if duplicate.

**Data quality gate** — Before every write, validates LinkedIn URLs, email domains, and that the person is real (not a mascot or bot).

---

## File Structure

```
src/
  index.ts                          # CLI entry (commander)
  config.ts                         # Env var loading + validation
  setup.ts                          # First-time Notion database creation
  enrichment/
    company-enricher.ts             # Stage 1: website scrape + Apollo org
    people-enricher.ts              # Stage 2: multi-pass discovery + AI
    apollo-client.ts                # Search (free) + Reveal (paid) + Org Search
    reveal-serp.ts                  # Stage 2b: Reveal SERP candidates
    brave-search-client.ts          # Brave Search SERP fallback
    website-scraper.ts              # HTML scraping for socials/emails
    email-enricher.ts               # Stage 3: email verification (placeholder)
    emailapi.ts                     # EmailAPI client (legacy)
  lib/
    ai-normalizer.ts                # All 9 AI decision functions (GPT 5.4)
    decision-engine.ts              # Best Outreach Path decision tree
    role-priority.ts                # Title/seniority constants
  notion/
    client.ts                       # Notion API wrapper + rate limiting
    company-db.ts                   # Company Enriched DB
    people-db.ts                    # People Enriched DB
    kickstarter-db.ts               # Kickstarter Campaign Outreach (read-only)
    types.ts                        # TypeScript types
    property.ts                     # Notion property builders
    readers.ts                      # Notion property readers
  utils/
    logger.ts, name-parser.ts, url.ts, rate-limiter.ts
```
