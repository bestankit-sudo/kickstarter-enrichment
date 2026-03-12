import { config as loadDotenv } from "dotenv";
import { homedir } from "node:os";

export type AppConfig = {
  notionApiKey: string;
  notionKickstarterDbId: string;
  notionCompanyEnrichedDbId: string;
  notionPeopleEnrichedDbId: string;
  proxycurlApiKey: string;
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

  const values = {
    notionApiKey: process.env.NOTION_API_KEY?.trim() || process.env.NOTION_TOKEN?.trim() || "",
    notionKickstarterDbId: process.env.NOTION_KICKSTARTER_DB_ID?.trim() ?? "",
    notionCompanyEnrichedDbId: process.env.NOTION_COMPANY_ENRICHED_DB_ID?.trim() ?? "",
    notionPeopleEnrichedDbId: process.env.NOTION_PEOPLE_ENRICHED_DB_ID?.trim() ?? "",
    proxycurlApiKey: process.env.PROXYCURL_API_KEY?.trim() ?? "",
  };

  for (const [k, v] of Object.entries(values)) {
    if (!v) {
      const map: Record<string, string> = {
        notionApiKey: "NOTION_API_KEY",
        notionKickstarterDbId: "NOTION_KICKSTARTER_DB_ID",
        notionCompanyEnrichedDbId: "NOTION_COMPANY_ENRICHED_DB_ID",
        notionPeopleEnrichedDbId: "NOTION_PEOPLE_ENRICHED_DB_ID",
        proxycurlApiKey: "PROXYCURL_API_KEY",
      };
      missing.push(map[k] ?? k);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")} (checked process env, .env, and ${secretsEnvPath})`);
  }

  return {
    ...values,
    secretsEnvPath: expandHome(process.env.SECRETS_ENV_PATH?.trim() || "~/.config/ankit-openclaw/secrets.env"),
  };
};

export const loadConfig = (): AppConfig => {
  const secretsEnvPath = expandHome(process.env.SECRETS_ENV_PATH?.trim() || "~/.config/ankit-openclaw/secrets.env");
  loadDotenv();
  loadDotenv({ path: secretsEnvPath, override: false });

  const config = readRequired(secretsEnvPath);
  return {
    ...config,
    secretsEnvPath,
  };
};
