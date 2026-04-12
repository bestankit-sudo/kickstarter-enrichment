# Kickstarter Enrichment Pipeline — Process Documentation

## Overview

A TypeScript CLI that enriches Kickstarter campaign data to find the best outreach contact for each company. The pipeline discovers company information, identifies key people, and writes structured data to 3 interconnected Notion databases.

The system prioritizes **precision over recall** and **cost control over breadth**. AI validates every data point before writing to Notion. Apollo credits are spent only on candidates the AI deems worth revealing.

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

## API Stack

| API | Purpose | Cost Model |
|-----|---------|-----------|
| Apollo People Search | Find candidates by domain/name/title | Free (search metadata) |
| Apollo People Reveal | Get full profile (LinkedIn, email, name) | 1 credit per person |
| Apollo Org Enrichment | Resolve company by name/domain | 1 credit per org |
| OpenAI GPT 5.4 | 9 AI decision points throughout pipeline | ~$0.01-0.05/company |
| Brave Search | SERP fallback for LinkedIn discovery | Per query |
| Notion API | Read/write all 3 databases | Free |

## CLI Commands

```bash
npm run enrich:companies                    # Stage 1: Website scraping + Apollo org
npm run enrich:people                       # Stage 2: Person discovery + AI scoring
npx tsx src/index.ts reveal-serp            # Stage 2b: Reveal SERP candidates via Apollo
npm run enrich:people -- --force            # Re-process all including done/partial rows
npm run enrich:people -- --limit 5          # Process first 5 companies only
npm run enrich:people -- --dry-run          # Preview without API calls
```

### Recommended run order
1. `enrich:companies` — scrape all websites, build company profiles
2. `enrich:people` — find people via Apollo + Brave Search
3. `reveal-serp` — upgrade SERP-found candidates with full Apollo profiles

---

## Stage 1: Company Enrichment (`enrich-companies`)

### What it does
For each Kickstarter campaign with an External Link, scrape the company website and extract contact channels.

### Process flow

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

4. Write to Company Enriched:
   → Set Source Campaign relation → Kickstarter Campaign Outreach
   → Set Enrichment Status (done/partial/failed/needs_review)
   → Set Last Checked At
```

### No AI involved in Stage 1
All extraction is regex-based. Apollo Org Search is the only paid API call, used only as a fallback.

---

## Stage 2: People Enrichment (`enrich-people`)

### What it does
For each enriched company, find the best person to contact. Uses a cost-optimized multi-pass approach: search for free, score with AI, reveal only the best candidates.

### Cost optimization principles

1. **Search is free, reveal is paid** — Apollo search returns metadata (first name, title, org) at no cost. Only reveal candidates the AI says are worth it.
2. **Sequential passes with early exit** — Stop searching when good enough results found.
3. **Deduplicate before reveal** — Same person from multiple searches = 1 reveal, not 3.
4. **Medium confidence stops escalation** — A medium-confidence founder is better than searching for random operators.
5. **Stale guard** — Don't re-enrich partial records within 7 days unless `--force`.

### Process flow (per company)

```
┌─────────────────────────────────────────────────────────┐
│ STAGE 2 PIPELINE — Per Company                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ① AI: Normalize founder names (GPT 5.4)                │
│     "Alex & Jamie (CEO)" → [{first: Alex}, {first: Jamie}] │
│                                                         │
│  ② SEARCH (FREE — no credits)                           │
│     Pass A1: domain + founder name + founder titles     │
│     Pass A2: company name + founder name (if A1 empty)  │
│     Pass A3: founder name + company keyword (if A2 empty) │
│     → Deduplicate all results by Apollo Person ID       │
│                                                         │
│  ③ AI: Preliminary score on search metadata (GPT 5.4)   │
│     "5 results → 2 worth revealing"                     │
│     Uses: first_name, title, org_name (free metadata)   │
│     Decides: which candidates to pay to reveal          │
│     Max reveals: 2 per pass                             │
│                                                         │
│  ④ REVEAL (PAID — 1 credit each)                        │
│     Only reveal candidates AI approved                  │
│     Returns: full name, LinkedIn URL, email, headline,  │
│              city, country, employment history, org data │
│                                                         │
│  ⑤ AI: Validate each revealed person (GPT 5.4)          │
│     "Does this person actually work at target company?" │
│     Uses: employment history, org name, email domain    │
│     Rejects: people at unrelated companies              │
│                                                         │
│  ⑥ AI: Score & rank validated candidates (GPT 5.4)      │
│     high / medium / low confidence                      │
│     + evidence summary (precise, names the employer)    │
│                                                         │
│  ┌─ Has medium+ confidence? ────────────────────────┐   │
│  │  YES → Skip Pass B, proceed to write             │   │
│  │  NO  → Continue to Pass B                        │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ⑦ Pass B: Operator titles (partnerships, marketing, BD)│
│     Same flow: search → prelim score → reveal top 2     │
│     → validate → score                                  │
│     (No broad search — removed for cost control)        │
│                                                         │
│  ┌─ Has usable candidates? ─────────────────────────┐   │
│  │  YES → Proceed to write                          │   │
│  │  NO  → Continue to Pass C                        │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ⑧ Pass C: Apollo Org Search → resolve real domain      │
│     → retry people search with org ID                   │
│     Same flow: search → prelim score → reveal → validate│
│                                                         │
│  ⑨ Pass D: Brave Search SERP fallback                   │
│     5 queries: "[founder] [company] site:linkedin.com/in" │
│     Max confidence from SERP: medium                    │
│     Stop at first clear result                          │
│                                                         │
│  ⑩ BEFORE WRITING — 4 AI gates:                         │
│                                                         │
│     AI: Data quality gate (GPT 5.4)                     │
│     → Validate URLs (reject non-LinkedIn in LinkedIn field) │
│     → Check email domain matches company domain         │
│     → Verify person is real (not mascot, bot, placeholder) │
│                                                         │
│     AI: Rebrand detection (GPT 5.4)                     │
│     → If Apollo domain ≠ stored domain, check if rebrand│
│     → "vsslgear.com → vssl.com" = same company          │
│                                                         │
│     AI: Merge decision (GPT 5.4)                        │
│     → Compare existing Notion row vs incoming data      │
│     → "Is this an improvement or duplicate?"            │
│     → Skip if duplicate, merge best-of-both if same person │
│                                                         │
│     AI: Outreach brief (GPT 5.4, primary candidates only) │
│     → "Their coffee pod maker aligns with your podcast  │
│        focus on sustainability in DTC brands"           │
│                                                         │
│  ⑪ AI: Company intelligence summary (GPT 5.4)           │
│     → From Apollo org data: industry, funding, employees│
│     → "VSSL is a Canadian outdoor gear brand..."        │
│                                                         │
│  ⑫ WRITE TO NOTION                                      │
│     → People Enriched: Full Name, LinkedIn, email, etc. │
│     → Company Enriched: backfill org data + roll-up     │
│     → Set relations: Company ↔ People ↔ Source Campaign │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 9 AI Decision Points (all GPT 5.4)

| # | Function | Input | Output | Cost Impact |
|---|----------|-------|--------|-------------|
| 1 | **Founder name normalization** | Raw "Founder / Creator" text | `[{ first_name, last_name }]` | Improves search accuracy |
| 2 | **Preliminary score** | Search metadata (name, title, org) | Which candidates to reveal (max 2) | **Saves 60-80% of reveal credits** |
| 3 | **Candidate validation** | Revealed person + employment history | Does this person work here? yes/no | Prevents junk data in Notion |
| 4 | **Candidate scoring** | All validated candidates | Ranked array with confidence + evidence | Determines primary candidate |
| 5 | **Data quality gate** | Person record + URLs + emails | Pass/fail + specific issues | Prevents bad URLs/emails |
| 6 | **Rebrand detection** | Domain A vs Domain B | Same company or different? | Prevents wrong domain searches |
| 7 | **Merge decision** | Existing row vs incoming data | Write / skip / merge fields | Prevents duplicates |
| 8 | **Outreach brief** | Primary candidate + campaign | 1-2 sentence talking point | Saves outreach prep time |
| 9 | **Company summary** | Apollo org data | 2-3 sentence intelligence | Contextualizes the company |

---

## Apollo API Usage

### Endpoints

| Endpoint | Purpose | Cost |
|----------|---------|------|
| `POST /api/v1/mixed_people/api_search` | Search by domain/name/title | **Free** |
| `POST /api/v1/people/match` | Reveal full profile | **1 credit** |
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
| `per_page` | 5 (default) | All passes |

### Domain blocklist
Prevents searching marketplace/social domains that return wrong people:
```
facebook.com, meta.com, amazon.com, google.com, twitter.com, x.com,
instagram.com, tiktok.com, youtube.com, linkedin.com, indiegogo.com,
igg.me, kickstarter.com, backerkit.com, shopify.com, etsy.com, ...
```

### Data extracted from reveal

**Person:** name, first_name, last_name, title, headline, linkedin_url, email, email_status, twitter_url, city, country, seniority, employment_history

**Company (free with reveal):** name, linkedin_url, primary_domain, short_description, industry, estimated_num_employees, founded_year, total_funding, latest_funding_stage, phone, keywords

---

## Notion Database Schema

### Kickstarter Campaign Outreach (read-only source)
- Campaign Name (title)
- Kickstarter URL, External Link
- Founder / Creator
- Country / Location
- Backers, Amount Pledged, Currency, Internal Category

### Company Enriched
- Campaign Name (title)
- **Source Campaign** → Relation to Kickstarter Campaign Outreach
- **Best Person** → Relation to People Enriched
- Company Name, Company Domain, Company Description
- LinkedIn Company URL, X URL, Instagram URL, Facebook URL, YouTube URL, TikTok URL
- Generic Business Email, Contact Form URL, Company Phone
- Industry, Founded Year, Total Funding, Funding Stage, Keywords
- Employee Count, Apollo Organisation ID
- Best Outreach Path, Primary Person Confidence, Company Outreach Readiness
- Enrichment Status, Match Confidence
- Source Notes, Sources Used, Last Checked At

### People Enriched
- **Full Name** (title — page name, shows in relations)
- **Company** → Relation to Company Enriched
- **Source Campaign** → Relation to Kickstarter Campaign Outreach
- First Name, Last Name, Headline
- LinkedIn Person URL, Work Emails, Email Status
- Job Title, Apollo Person ID, Discovery Method
- Candidate Rank, Is Primary Candidate
- Match Confidence, Evidence Summary, Match Notes
- City, Country, Twitter X URL
- Enrich Status, Last Enriched At, Last Error

---

## Stage 2b: Reveal SERP Candidates (`reveal-serp`)

### What it does
After Stage 2, some candidates were found via Brave Search (SERP fallback). They have LinkedIn URLs and names from search results, but no email, headline, city, country, or employment history. This command reveals them through Apollo's People Match endpoint using their LinkedIn URL.

### Process flow

```
1. Query People Enriched for rows where Discovery Method = serp_fallback
   AND LinkedIn Person URL is populated AND Apollo Person ID is empty
2. For each SERP candidate:
   a. Call Apollo People Match with LinkedIn URL (1 credit)
   b. Get full profile: name, title, headline, email, city, country, employment history
   c. Update the existing Notion row with full Apollo data
3. Log results: how many revealed, how many got verified emails
```

### When to run
After `enrich:people` completes. Only processes candidates that don't already have Apollo data.

---

## Cost Model

### Per company (estimated)

| Step | API calls | Credits |
|------|----------|---------|
| Apollo search (Pass A: 1-3 searches) | 1-3 | **Free** |
| Apollo preliminary score (GPT 5.4) | 1 | ~$0.003 |
| Apollo reveal (only AI-approved) | 1-2 | **1-2 credits** |
| AI validate + score + quality gate | 3-5 | ~$0.01 |
| Apollo Pass B search (if needed) | 0-1 | **Free** |
| Apollo Pass C org search (rare) | 0-1 | **0-1 credit** |
| AI merge + outreach + summary | 1-3 | ~$0.005 |

### For 51 companies (estimated)

| | Before optimization | After optimization |
|---|---|---|
| Apollo reveals | ~200 | **~40-60** |
| OpenAI calls | ~150 | ~200 (more AI gates, but saves credits) |
| OpenAI cost | ~$2 | ~$3 |
| Apollo credits | ~200 | **~60** |

**Net: 70% fewer Apollo credits at the cost of ~$1 more OpenAI.**

---

## Safeguards

### Stale guard
Records with `Enrich Status = partial` or `needs_review` are skipped if `Last Enriched At` is less than 7 days ago. Prevents burning credits on records that won't improve. Override with `--force`.

### Domain blocklist
15+ domains (facebook.com, amazon.com, etc.) blocked before Apollo search. Prevents revealing Facebook employees when the source External Link was a Facebook page.

### AI merge decision
Before every Notion write, GPT 5.4 compares existing data vs incoming:
- **Same person, new data** → Write (merge best of both)
- **Same person, no improvement** → Skip (save the API call)
- **Different person, better** → Write
- **Different person, worse** → Skip

### Data quality gate
Before every Notion write, GPT 5.4 validates:
- LinkedIn URL is actually `linkedin.com/in/` (not twitter.com, facebook.com)
- Email domain matches company domain (or Apollo-resolved domain for rebrands)
- Person is a real human (not a mascot, bot, or placeholder name)

---

## File Structure

```
src/
  index.ts                          # CLI entry (commander)
  config.ts                         # Env var loading + validation
  enrichment/
    company-enricher.ts             # Stage 1: website scrape + Apollo org
    people-enricher.ts              # Stage 2: multi-pass discovery + AI
    apollo-client.ts                # Search (free) + Reveal by ID/LinkedIn (paid) + Org Search
    reveal-serp.ts                  # Stage 2b: Reveal SERP candidates via Apollo LinkedIn match
    brave-search-client.ts          # Brave Search SERP fallback
    website-scraper.ts              # HTML scraping for socials/emails
    email-enricher.ts               # Stage 3: email verification (placeholder)
    emailapi.ts                     # EmailAPI client (legacy)
  lib/
    ai-normalizer.ts                # All 9 AI decision functions (GPT 5.4)
    decision-engine.ts              # Best Outreach Path decision trees
    role-priority.ts                # Title/seniority constants
  notion/
    client.ts                       # Notion API wrapper + rate limiting
    company-db.ts                   # Company Enriched DB (findByCampaignName, upsert, backfillFromApolloOrg, updateRollup)
    people-db.ts                    # People Enriched DB (findByApolloPersonId, findByFullName, upsert)
    kickstarter-db.ts               # Kickstarter Campaign Outreach (read-only)
    types.ts                        # TypeScript types
    property.ts                     # Notion property builders
    readers.ts                      # Notion property readers
  utils/
    logger.ts, name-parser.ts, url.ts, rate-limiter.ts
```
