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

### 5. Run the Pipeline

```bash
# Stage 1: Scrape websites, extract socials and emails
npm run enrich:companies

# Stage 2: Find people via Apollo + AI scoring
npm run enrich:people

# Stage 2b: Upgrade SERP-found candidates with full Apollo profiles
npx tsx src/index.ts reveal-serp

# Stage 3: Fix names + deduplicate contacts
npx tsx src/fix-names-and-dedup.ts fix-names
npx tsx src/fix-names-and-dedup.ts dedup

# Stage 4: Link all relations + final audit
npx tsx src/cleanup-pipeline.ts phase4   # companies ↔ campaigns
npx tsx src/cleanup-pipeline.ts phase5   # people → companies
npx tsx src/cleanup-pipeline.ts phase6   # people → campaigns
npx tsx src/cleanup-pipeline.ts audit    # verify everything
```

---

## Complete Pipeline — End to End

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         FULL ENRICHMENT PROCESS                             │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ STAGE 1: Company Enrichment                                          │  │
│  │   npm run enrich:companies                                           │  │
│  │                                                                      │  │
│  │   For each campaign:                                                 │  │
│  │   1. Extract domain from External Link                               │  │
│  │   2. Check domain against blocklist                                  │  │
│  │   3. Scrape homepage + sub-pages (/contact, /about, /contact-us)     │  │
│  │      → Extract: socials, business email, contact form URL            │  │
│  │   4. If scrape fails → Apollo Org Search fallback (1 credit)         │  │
│  │   5. Write to Company Enriched                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                               ↓                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ STAGE 2: People Enrichment                                           │  │
│  │   npm run enrich:people                                              │  │
│  │                                                                      │  │
│  │   For each company:                                                  │  │
│  │   ① AI: Normalize founder names from campaign data                   │  │
│  │   ② Pass A: Apollo search — domain + name + titles (FREE)            │  │
│  │      A1: domain + founder + founder titles                           │  │
│  │      A2: company name + founder (if A1 empty)                        │  │
│  │      A3: founder name + company keyword (if A2 empty)                │  │
│  │   ③ AI: Preliminary score — pick max 2 to reveal                     │  │
│  │   ④ Apollo Reveal — get full profile (1 credit each)                 │  │
│  │   ⑤ AI: Validate — does person work at target company?               │  │
│  │   ⑥ AI: Score & rank — high/medium/low confidence                    │  │
│  │      ↓                                                               │  │
│  │   If medium+ found → skip to write                                   │  │
│  │      ↓                                                               │  │
│  │   ⑦ Pass B: Operator titles (partnerships, marketing, BD)            │  │
│  │   ⑧ Pass C: Apollo Org resolve → search by org ID                    │  │
│  │   ⑨ Pass D: Brave Search SERP fallback (max confidence: medium)      │  │
│  │      ↓                                                               │  │
│  │   ⑩ AI: Data quality gate (real person? valid LinkedIn?)             │  │
│  │   ⑪ AI: Merge decision (duplicate check against existing records)    │  │
│  │   ⑫ AI: Outreach brief (primary candidate only)                      │  │
│  │   ⑬ AI: Company intelligence summary                                 │  │
│  │   ⑭ Write to People Enriched + update Company roll-up                │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                               ↓                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ STAGE 2b: Reveal SERP Candidates                                     │  │
│  │   npx tsx src/index.ts reveal-serp                                   │  │
│  │                                                                      │  │
│  │   For each SERP-only person (has LinkedIn, no Apollo ID):            │  │
│  │   1. Apollo Reveal by LinkedIn URL (1 credit)                        │  │
│  │   2. Update person with full profile data                            │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                               ↓                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ STAGE 3: Name Normalization + Dedup                                  │  │
│  │   npx tsx src/fix-names-and-dedup.ts fix-names                       │  │
│  │   npx tsx src/fix-names-and-dedup.ts dedup                           │  │
│  │                                                                      │  │
│  │   3a. Fix dirty names from SERP and Apollo:                          │  │
│  │       "John Smith - CEO - Acme Corp" → Full Name: "John Smith"       │  │
│  │       Extract title: "CEO", fix capitalization                       │  │
│  │       Separators handled: " - ", " — ", " | "                        │  │
│  │       Patterns: "Name - Title at Company", "Name - Title - Company"  │  │
│  │                                                                      │  │
│  │   3b. Fix Full Name = First Name + Last Name (any mismatches)        │  │
│  │       npx tsx src/migrate-relations.ts 4                             │  │
│  │                                                                      │  │
│  │   3c. Dedup by Apollo Person ID:                                     │  │
│  │       npx tsx src/cleanup-pipeline.ts phase1                         │  │
│  │       Score each: email (+8), LinkedIn (+5), Apollo ID (+10), etc.   │  │
│  │       Keep highest-scored, merge fields from losers, archive rest    │  │
│  │                                                                      │  │
│  │   3d. Dedup by normalized name + company:                            │  │
│  │       npx tsx src/fix-names-and-dedup.ts dedup                       │  │
│  │       Groups by lowercase(Full Name) + company ID                    │  │
│  │       Same scoring + merge + archive logic                           │  │
│  │                                                                      │  │
│  │   3e. Archive orphans (no company AND no campaign):                  │  │
│  │       npx tsx src/cleanup-pipeline.ts archive-orphans                │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                               ↓                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ STAGE 4: Relation Linking + Final Audit                              │  │
│  │                                                                      │  │
│  │   4a. Link companies ↔ campaigns (by name match):                    │  │
│  │       npx tsx src/cleanup-pipeline.ts phase4                         │  │
│  │                                                                      │  │
│  │   4b. Link people → companies (via campaign, email domain, or text): │  │
│  │       npx tsx src/cleanup-pipeline.ts phase5                         │  │
│  │       Strategy 1: Infer from campaign relation                       │  │
│  │       Strategy 2: Match by email domain → company domain             │  │
│  │       Strategy 3: Match company name in evidence/headline text       │  │
│  │                                                                      │  │
│  │   4c. Link people → campaigns (inherit from company):                │  │
│  │       npx tsx src/cleanup-pipeline.ts phase6                         │  │
│  │                                                                      │  │
│  │   4d. Final audit — verify zero orphans, zero dupes:                 │  │
│  │       npx tsx src/cleanup-pipeline.ts audit                          │  │
│  │                                                                      │  │
│  │   Expected results:                                                  │  │
│  │     Nameless people:      0 ✓                                        │  │
│  │     Duplicate Apollo IDs: 0 ✓                                        │  │
│  │     No Linked Company:    0 ✓                                        │  │
│  │     No Campaigns:         0 ✓                                        │  │
│  │     "not found" LinkedIn: 0 ✓                                        │  │
│  │     Every company → campaign ✓                                       │  │
│  │     Every campaign → company ✓                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Commands

### Core Pipeline

| Command | Stage | Description |
|---------|-------|-------------|
| `npm run enrich:companies` | 1 | Website scraping + Apollo org resolution |
| `npm run enrich:people` | 2 | Person discovery + AI scoring |
| `npx tsx src/index.ts reveal-serp` | 2b | Reveal SERP candidates via Apollo |
| `npx tsx src/fix-names-and-dedup.ts fix-names` | 3a | Clean dirty names (SERP/Apollo junk) |
| `npx tsx src/migrate-relations.ts 4` | 3b | Fix Full Name = First + Last |
| `npx tsx src/cleanup-pipeline.ts phase1` | 3c | Dedup by Apollo Person ID |
| `npx tsx src/fix-names-and-dedup.ts dedup` | 3d | Dedup by name + company |
| `npx tsx src/cleanup-pipeline.ts archive-orphans` | 3e | Archive unlinked orphan contacts |
| `npx tsx src/cleanup-pipeline.ts phase4` | 4a | Link companies ↔ campaigns |
| `npx tsx src/cleanup-pipeline.ts phase5` | 4b | Link people → companies |
| `npx tsx src/cleanup-pipeline.ts phase6` | 4c | Link people → campaigns |
| `npx tsx src/cleanup-pipeline.ts audit` | 4d | Final data quality audit |

### Flags

| Flag | Works with | Description |
|------|-----------|-------------|
| `--force` | enrich:companies, enrich:people | Re-process done/partial records |
| `--limit N` | enrich:companies, enrich:people | Process first N records only |
| `--dry-run` | enrich:companies, enrich:people | Preview without API calls or writes |
| `--url <kickstarter-url>` | enrich:companies, enrich:people | Process single campaign |

### Verification

| Command | Description |
|---------|-------------|
| `npx tsx src/verify-company-campaign.ts` | Verify every company ↔ campaign link |
| `npx tsx src/verify-company-people.ts` | Verify every company has linked people |
| `npx tsx src/check-company-contacts.ts` | Check contact channels for companies without people |
| `npx tsx src/cleanup-audit.ts` | Detailed pre-cleanup data quality audit |

---

## Architecture

```
Kickstarter Campaign Outreach (read-only source)
        ↕ Campaigns relation (dual)
Company Enriched (Stage 1 + Apollo org backfill)
        ↕ All People / Linked Company relation (dual) + Best Person relation
People Enriched (Stage 2 — person discovery)
        ↕ Campaigns relation (dual, back to Kickstarter)
```

All 3 databases are bidirectionally linked via dual relations. Clicking any relation navigates between tables.

### Notion Database Schema

**Kickstarter Campaign Outreach** (read-only source)
Campaign Name, Kickstarter URL, External Link, Country / Location, Backers, Amount Pledged, Currency, Internal Category, **Companies** (→ Company Enriched), **People** (→ People Enriched)

**Company Enriched**
Campaign Name, **Campaigns** (→ Kickstarter), **All People** (→ People Enriched), **Best Person** (→ People Enriched), Company Name, Company Domain, Company Description, LinkedIn Company URL, X URL, Instagram URL, Facebook URL, YouTube URL, TikTok URL, Generic Business Email, Contact Form URL, Company Phone, Industry, Founded Year, Total Funding, Funding Stage, Keywords, Employee Count, Apollo Organisation ID, Company Country, Best Outreach Path, Primary Person Confidence, Company Outreach Readiness, Enrichment Status, Match Confidence, Source Notes, Sources Used, Last Checked At, **People Count** (rollup)

**People Enriched**
**Full Name** (title), **Linked Company** (→ Company Enriched), **Campaigns** (→ Kickstarter), First Name, Last Name, Headline, Linkedin Person Url, Work Emails, Email Status, Job Title, Apollo Person ID, Discovery Method, Candidate Rank, Is Primary Candidate, Match Confidence, Evidence Summary, Match Notes, City, Country, Twitter X Url, Enrich Status, Last Enriched At, Last Error, **Campaign Name** (rollup), **Company Name** (rollup)

---

## API Stack

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
   3a. Scrape homepage HTML
       → Extract social URLs (LinkedIn, X, Instagram, Facebook, YouTube, TikTok)
       → Extract business email (prefers domain-matching emails)
   3b. If homepage missing email/socials:
       → Scrape sub-pages: /contact, /contact-us, /about, /about-us, /pages/contact
       → Extract contact form URLs from <form> elements and link patterns
   3c. If scrape fails (403, timeout, dead domain):
       → Apollo Org Search by campaign name (paid, 1 credit)
       → If resolved: write Apollo org ID + domain to Company Enriched

   No domain or blocked domain:
   3d. Apollo Org Search by campaign name (paid, 1 credit)
       → If resolved: write Apollo org ID + domain

4. Write to Company Enriched with Campaigns relation
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

---

## Stage 3: Name Normalization + Dedup

After enrichment, contacts need name cleanup and deduplication. SERP-sourced and Apollo-sourced names often contain embedded titles, company names, and location data.

### 3a. Fix dirty names

```bash
npx tsx src/fix-names-and-dedup.ts fix-names
```

Parses names like:
- `"John Smith - CEO - Acme Corp"` → Full Name: `"John Smith"`, Job Title: `"CEO"`
- `"Jane Doe - Founder at StartupXYZ"` → Full Name: `"Jane Doe"`, Job Title: `"Founder"`
- `"maggie hanford - owner at phototag"` → Full Name: `"Maggie Hanford"`, Job Title: `"owner"`

Handles separators: ` - `, ` — `, ` | `

### 3b. Fix Full Name consistency

```bash
npx tsx src/migrate-relations.ts 4
```

Ensures Full Name = trim(First Name) + " " + trim(Last Name) for every record.

### 3c. Dedup by Apollo Person ID

```bash
npx tsx src/cleanup-pipeline.ts phase1
```

Groups people by Apollo Person ID. For each group with duplicates:
- Score each record: email (+8), LinkedIn (+5), Apollo ID (+10), job title (+3), headline (+2), evidence length, status
- Keep highest-scored record
- Merge missing fields from losers into winner (best-of-both)
- Archive losers

### 3d. Dedup by name + company

```bash
npx tsx src/fix-names-and-dedup.ts dedup
```

Groups people by `lowercase(Full Name) + company ID`. Same scoring, merge, and archive logic. Catches duplicates that have different Apollo IDs but are the same person at the same company (e.g. from SERP + Apollo discovery in separate runs).

### 3e. Archive orphans

```bash
npx tsx src/cleanup-pipeline.ts archive-orphans
```

Archives people with no Linked Company AND no Campaigns relation. Contacts that can't be associated with any company or campaign have no outreach value.

---

## Stage 4: Relation Linking + Final Audit

Ensures every record is properly connected across all 3 databases.

### 4a. Link companies ↔ campaigns

```bash
npx tsx src/cleanup-pipeline.ts phase4
```

Matches Company Enriched → Campaign Outreach by exact or normalized name match. Company names = Campaign names in this dataset.

### 4b. Link people → companies

```bash
npx tsx src/cleanup-pipeline.ts phase5
```

Three strategies (tried in order):
1. **Campaign inference** — person's campaign → that campaign's company
2. **Email domain** — person's email domain matches company domain
3. **Text match** — company name found in person's evidence/headline/match notes

### 4c. Link people → campaigns

```bash
npx tsx src/cleanup-pipeline.ts phase6
```

Inherits campaigns from linked company. If person → company → campaign, set person → campaign.

### 4d. Final audit

```bash
npx tsx src/cleanup-pipeline.ts audit
```

Verifies:
- 0 nameless people
- 0 duplicate Apollo IDs
- 0 people without Linked Company
- 0 people without Campaigns
- 0 "not found" LinkedIn URLs
- All companies linked to campaigns
- All campaigns linked to companies

---

## 9 AI Decision Points

| # | Function | Input | Output | Cost Impact |
|---|----------|-------|--------|-------------|
| 1 | Founder name normalization | Raw text | Parsed name array | Improves search accuracy |
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

### Domain blocklist

Prevents searching marketplace/social domains that return wrong people:
`facebook.com, amazon.com, indiegogo.com, igg.me, kickstarter.com, backerkit.com, shopify.com, etsy.com, ...`

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

**Data quality gate** — Before every write, validates LinkedIn URLs and that the person is real (not a mascot or bot). Accepts LinkedIn-only contacts for outreach.

**Post-enrichment dedup** — Two-layer dedup (Apollo ID then name+company) catches duplicates from multiple enrichment runs or SERP+Apollo sources.

**Name normalization** — Strips embedded titles, companies, and locations from SERP-sourced names before dedup. Prevents false-negative matches like "John Smith" vs "John Smith - CEO - Acme Corp".

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
    website-scraper.ts              # HTML scraping for socials/emails + sub-pages
    email-enricher.ts               # Stage 3: email verification (placeholder)
    emailapi.ts                     # EmailAPI client (legacy)
  lib/
    ai-normalizer.ts                # All 9 AI decision functions (GPT 5.4)
    decision-engine.ts              # Best Outreach Path decision tree
    role-priority.ts                # Title/seniority constants
  notion/
    client.ts                       # Notion API wrapper + rate limiting
    company-db.ts                   # Company Enriched DB operations
    people-db.ts                    # People Enriched DB operations
    kickstarter-db.ts               # Kickstarter Campaign Outreach (read-only)
    types.ts                        # TypeScript types
    property.ts                     # Notion property builders
    readers.ts                      # Notion property readers
  utils/
    logger.ts                       # Structured logging
    name-parser.ts                  # Name parsing utilities
    url.ts                          # URL normalization + domain extraction
    rate-limiter.ts                 # Request queue + exponential backoff
  fix-names-and-dedup.ts            # Stage 3: name normalization + name-based dedup
  cleanup-pipeline.ts               # Stage 4: relation linking + dedup + audit
  cleanup-audit.ts                  # Pre-cleanup data quality audit
  migrate-relations.ts              # One-time relation migration tasks
  verify-company-campaign.ts        # Verify company ↔ campaign links
  verify-company-people.ts          # Verify company → people links
  check-company-contacts.ts         # Check contact channels for companies without people
```
