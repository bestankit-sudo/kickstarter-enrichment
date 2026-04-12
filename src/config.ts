import { config as loadDotenv } from "dotenv";
import { homedir } from "node:os";

export type AppConfig = {
  notionApiKey: string;
  notionKickstarterDbId: string;
  notionCompanyEnrichedDbId: string;
  notionPeopleEnrichedDbId: string;
  apolloApiKey: string;
  braveSearchApiKey: string;
  openaiApiKey: string;
  proxycurlApiKey: string;
  emailApiAppDomain: string;
  emailApiAuthKey: string;
  emailApiAuthSecret: string;
  secretsEnvPath: string;
};

const expandHome = (value: string): string => {
  if (value.startsWith("~/")) {
    return value.replace("~", homedir());
  }
  return value;
};

const readRequired = (secretsEnvPath: string): AppConfig => {
  const missing: string[] = [];

  const required = {
    notionApiKey: process.env.NOTION_API_KEY?.trim() || process.env.NOTION_TOKEN?.trim() || "",
    notionKickstarterDbId: process.env.NOTION_KICKSTARTER_DB_ID?.trim() ?? "",
    notionCompanyEnrichedDbId: process.env.NOTION_COMPANY_ENRICHED_DB_ID?.trim() ?? "",
    notionPeopleEnrichedDbId: process.env.NOTION_PEOPLE_ENRICHED_DB_ID?.trim() ?? "",
    apolloApiKey: process.env.APOLLO_API_KEY?.trim() ?? "",
    braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY?.trim() ?? "",
    openaiApiKey: process.env.OPENAI_API_KEY_PODSQUE?.trim() ?? "",
  };

  const requiredEnvMap: Record<string, string> = {
    notionApiKey: "NOTION_API_KEY",
    notionKickstarterDbId: "NOTION_KICKSTARTER_DB_ID",
    notionCompanyEnrichedDbId: "NOTION_COMPANY_ENRICHED_DB_ID",
    notionPeopleEnrichedDbId: "NOTION_PEOPLE_ENRICHED_DB_ID",
    apolloApiKey: "APOLLO_API_KEY",
    braveSearchApiKey: "BRAVE_SEARCH_API_KEY",
    openaiApiKey: "OPENAI_API_KEY_PODSQUE",
  };

  for (const [k, v] of Object.entries(required)) {
    if (!v) {
      missing.push(requiredEnvMap[k] ?? k);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")} (checked process env, .env, and ${secretsEnvPath})`);
  }

  const optional = {
    proxycurlApiKey: process.env.PROXYCURL_API_KEY?.trim() ?? "",
    emailApiAppDomain: process.env.EMAILAPI_APP_DOMAIN?.trim() ?? "",
    emailApiAuthKey: process.env.EMAILAPI_AUTH_KEY?.trim() ?? "",
    emailApiAuthSecret: process.env.EMAILAPI_AUTH_SECRET?.trim() ?? "",
  };

  return {
    ...required,
    ...optional,
    secretsEnvPath: expandHome(process.env.SECRETS_ENV_PATH?.trim() || "~/.config/env-variables/secrets.env"),
  };
};

export const loadConfig = (): AppConfig => {
  const secretsEnvPath = expandHome(process.env.SECRETS_ENV_PATH?.trim() || "~/.config/env-variables/secrets.env");
  loadDotenv();
  loadDotenv({ path: secretsEnvPath, override: false });

  const config = readRequired(secretsEnvPath);
  return {
    ...config,
    secretsEnvPath,
  };
};
