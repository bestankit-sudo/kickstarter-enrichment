import { CompanyDb } from "../notion/company-db.js";
import { PeopleDb } from "../notion/people-db.js";
import { findWorkEmail } from "./emailapi.js";
import { logger } from "../utils/logger.js";

type EnrichEmailsOptions = {
  companyDb: CompanyDb;
  peopleDb: PeopleDb;
  emailApiAppDomain: string;
  emailApiAuthKey: string;
  emailApiAuthSecret: string;
  force: boolean;
  dryRun: boolean;
  limit?: number;
};

export async function enrichEmails(options: EnrichEmailsOptions): Promise<void> {
  if (!options.emailApiAppDomain || !options.emailApiAuthKey || !options.emailApiAuthSecret) {
    logger.error("[enrich-emails] Missing EmailAPI credentials.");
    return;
  }

  logger.info("[enrich-emails] Stage 3 email verification — not yet wired to new schema. Use Apollo reveal emails instead.");
}
