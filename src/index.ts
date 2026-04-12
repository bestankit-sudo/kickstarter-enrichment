import { Command } from "commander";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "./config.js";
import { NotionService } from "./notion/client.js";
import { KickstarterDb } from "./notion/kickstarter-db.js";
import { CompanyDb } from "./notion/company-db.js";
import { PeopleDb } from "./notion/people-db.js";
import { enrichPeople } from "./enrichment/people-enricher.js";
import { enrichCompanies } from "./enrichment/company-enricher.js";
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

const run = async (commandName: string, options: CommonOptions): Promise<void> => {
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

  if (commandName === "enrich-companies") {
    await enrichCompanies({
      kickstarterDb,
      companyDb,
      apolloApiKey: config.apolloApiKey,
      force: Boolean(options.force),
      dryRun: Boolean(options.dryRun),
      limit,
      kickstarterUrl: options.url,
    });
  } else if (commandName === "enrich-people") {
    await enrichPeople({
      companyDb,
      peopleDb,
      kickstarterDb,
      apolloApiKey: config.apolloApiKey,
      braveSearchApiKey: config.braveSearchApiKey,
      openaiApiKey: config.openaiApiKey,
      force: Boolean(options.force),
      dryRun: Boolean(options.dryRun),
      limit,
      kickstarterUrl: options.url,
    });
  } else if (commandName === "reveal-serp") {
    const { revealSerpCandidates } = await import("./enrichment/reveal-serp.js");
    await revealSerpCandidates({
      peopleDb,
      companyDb,
      apolloApiKey: config.apolloApiKey,
      openaiApiKey: config.openaiApiKey,
      dryRun: Boolean(options.dryRun),
      limit,
    });
  } else if (commandName === "enrich-emails") {
    const { enrichEmails } = await import("./enrichment/email-enricher.js");
    await enrichEmails({
      companyDb,
      peopleDb,
      emailApiAppDomain: config.emailApiAppDomain,
      emailApiAuthKey: config.emailApiAuthKey,
      emailApiAuthSecret: config.emailApiAuthSecret,
      force: Boolean(options.force),
      dryRun: Boolean(options.dryRun),
      limit,
    });
  }
};

const program = new Command();
program.name("kickstarter-enrichment").description("Kickstarter campaign enrichment CLI");

const commonOptions = (cmd: Command): Command =>
  cmd
    .option("--force", "Re-process rows with done status")
    .option("--dry-run", "Show what would be processed")
    .option("--limit <n>", "Process at most N campaigns")
    .option("--url <kickstarter-url>", "Process only one Kickstarter URL");

commonOptions(program.command("enrich-companies")).action(
  async (options: CommonOptions) => {
    await run("enrich-companies", options);
  },
);

commonOptions(program.command("reveal-serp")).action(
  async (options: CommonOptions) => {
    await run("reveal-serp", options);
  },
);

commonOptions(program.command("enrich-people")).action(
  async (options: CommonOptions) => {
    await run("enrich-people", options);
  },
);

commonOptions(program.command("enrich-emails")).action(
  async (options: CommonOptions) => {
    await run("enrich-emails", options);
  },
);

program.parseAsync(process.argv).catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : "Unknown fatal error");
  process.exit(1);
});
