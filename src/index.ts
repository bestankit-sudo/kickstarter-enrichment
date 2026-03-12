import { Command } from "commander";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "./config.js";
import { NotionService } from "./notion/client.js";
import { KickstarterDb } from "./notion/kickstarter-db.js";
import { CompanyDb } from "./notion/company-db.js";
import { PeopleDb } from "./notion/people-db.js";
import { enrichPeople } from "./enrichment/people-enricher.js";
import { logger } from "./utils/logger.js";

type CommonOptions = {
  force?: boolean;
  dryRun?: boolean;
  limit?: string;
  url?: string;
};

const parseLimit = (raw: string | undefined): number | undefined => {
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --limit value: ${raw}`);
  }
  return parsed;
};

const askContinue = async (): Promise<boolean> => {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question("Continue? (Y/n) ")).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
};

const run = async (commandName: "enrich-people", options: CommonOptions): Promise<void> => {
  const config = loadConfig();

  const notion = new NotionService(config.notionApiKey);
  const kickstarterDb = new KickstarterDb(notion, config.notionKickstarterDbId);
  const companyDb = new CompanyDb(notion, config.notionCompanyEnrichedDbId);
  const peopleDb = new PeopleDb(notion, config.notionPeopleEnrichedDbId);

  logger.info(`[${commandName}] Config loaded from env + ${config.secretsEnvPath}`);

  const proceed = await askContinue();
  if (!proceed) {
    logger.warn(`[${commandName}] Aborted by user.`);
    return;
  }

  const limit = parseLimit(options.limit);

  await enrichPeople({
    companyDb,
    peopleDb,
    kickstarterDb,
    proxycurlApiKey: config.proxycurlApiKey,
    force: Boolean(options.force),
    dryRun: Boolean(options.dryRun),
    limit,
    kickstarterUrl: options.url,
  });
};

const program = new Command();
program.name("kickstarter-enrichment").description("Kickstarter campaign enrichment CLI");

program
  .command("enrich-people")
  .option("--force", "Re-process rows with done status")
  .option("--dry-run", "Show what would be processed")
  .option("--limit <n>", "Process at most N campaigns")
  .option("--url <kickstarter-url>", "Process only one Kickstarter URL")
  .action(async (options: CommonOptions) => {
    await run("enrich-people", options);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : "Unknown fatal error");
  process.exit(1);
});
