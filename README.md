# Kickstarter Enrichment CLI

Standalone TypeScript CLI that enriches Kickstarter campaign contact data stored in Notion. Runs a two-stage pipeline:

1. **Company enrichment** — extracts company domain and social media profiles from the external website linked in a Kickstarter campaign
2. **People enrichment** — identifies founders, C-level, and director-level contacts via Proxycurl role lookups

## How it works

```
Kickstarter DB (Notion)
  → reads campaign name, URL, external link, founder/creator
  → scrapes external website for domain, socials, email
  → writes to Company Enriched DB (Notion)
  → looks up people by role via Proxycurl
  → writes to People Enriched DB (Notion)
```

### Services used

| Service | Purpose |
|---------|---------|
| Notion API | Reads campaigns, writes enriched company + people records |
| Proxycurl | Role-based person lookup (CEO, Founder, CTO, COO/CMO) |
| Website scraping | Extracts domain, social profiles (LinkedIn, X, Instagram, Facebook, YouTube, TikTok), and business emails |

## Setup

```bash
npm install
cp .env.example .env   # fill in your keys
```

Env values load from two sources:
1. Local `.env` in project root (optional)
2. `SECRETS_ENV_PATH` (defaults to `~/.config/ankit-openclaw/secrets.env`)

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NOTION_API_KEY` | Yes | Notion integration token |
| `NOTION_KICKSTARTER_DB_ID` | Yes | Source Kickstarter database ID |
| `NOTION_COMPANY_ENRICHED_DB_ID` | Yes | Company enrichment output database ID |
| `NOTION_PEOPLE_ENRICHED_DB_ID` | Yes | People enrichment output database ID |
| `PROXYCURL_API_KEY` | Yes | Proxycurl API key for role lookups |
| `SECRETS_ENV_PATH` | No | Shared secrets file (default: `~/.config/ankit-openclaw/secrets.env`) |

## Commands

```bash
# People enrichment
npm run enrich:people -- --dry-run --limit 1   # preview without writes
npm run enrich:people -- --limit 5              # enrich 5 campaigns
npm run enrich:people -- --url "https://..."    # enrich one specific campaign
npm run enrich:people -- --force --limit 1      # reprocess already-done records
```

### Flags

| Flag | Description |
|------|-------------|
| `--dry-run` | No external API calls, no Notion writes — preview only |
| `--force` | Reprocess records already marked as `done` |
| `--limit N` | Process only first N campaigns |
| `--url "..."` | Process only the campaign matching this Kickstarter URL |

### Roles written per company

| Role | Source |
|------|--------|
| Founder | Parsed from Kickstarter "Founder / Creator" field |
| Co-Founder | One row per additional founder (split by `,`, `;`, `and`, `&`) |
| C-Level executive | Proxycurl role lookup |
| Director-level executive | Proxycurl role lookup |

## Low-credit validation path

To test with minimal Proxycurl API usage:

1. Ensure Company Enriched DB already has rows with `done` or `partial` status and a non-empty company domain
2. `npm run enrich:people -- --limit 1`

## Tests

```bash
npm test
```

Covers: founder name parsing, URL normalization, domain extraction, social scraping, email extraction.
