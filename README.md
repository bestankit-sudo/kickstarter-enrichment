# Kickstarter Enrichment CLI

Standalone TypeScript CLI to enrich Kickstarter contact data in Notion.

This tool reads from **Company Enriched** data and writes to **People Enriched** data.
It uses **Proxycurl** for person role lookups.

## Setup

```bash
npm install
cp .env.example .env
```

This project loads env values from both:
1. local `.env` in project root (optional)
2. `SECRETS_ENV_PATH` (defaults to `~/.config/ankit-openclaw/secrets.env`)

## Commands

```bash
npm run enrich:people -- --dry-run --limit 1
npm run enrich:people -- --limit 1
```

Flags:
- `--force`: reprocess records marked as `done`
- `--dry-run`: no external API calls and no Notion writes
- `--limit N`: process only first N campaigns
- `--url "..."`: process only one Kickstarter URL

Role rows written per company:
- `Founder`
- `Co-Founder` (one row per additional founder parsed from source)
- `C Level executive`
- `Director level executive`

Founder parsing notes:
- Founders are split from `Founder / Creator` using delimiters like `,`, `;`, `and`, `&`.
- Each parsed founder is written as its own person row.

## Low-credit validation path

If you want to test with one contact and minimize paid usage:

1. Ensure Company Enriched DB already has rows with `done` or `partial` status and a non-empty company domain
2. `npm run enrich:people -- --limit 1`

Notes:
- Proxycurl is used for role/person lookup and LinkedIn profile enrichment.

## Tests

```bash
npm test
```
