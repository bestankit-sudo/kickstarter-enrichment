import axios from "axios";
import { extractDomain } from "../utils/url.js";

export type WebsiteScrapeResult = {
  fetched: boolean;
  sourceNotes: string;
  socials: {
    linkedin: string | null;
    x: string | null;
    instagram: string | null;
    facebook: string | null;
    youtube: string | null;
    tiktok: string | null;
  };
  businessEmail: string | null;
};

const SOCIAL_PATTERNS: Record<keyof WebsiteScrapeResult["socials"], RegExp> = {
  linkedin: /https?:\/\/(www\.)?linkedin\.com\/company\/[^/"'\s?#]+/gi,
  x: /https?:\/\/(www\.)?(x\.com|twitter\.com)\/[^/"'\s?#]+/gi,
  instagram: /https?:\/\/(www\.)?instagram\.com\/[^/"'\s?#]+/gi,
  facebook: /https?:\/\/(www\.)?facebook\.com\/[^/"'\s?#]+/gi,
  youtube: /https?:\/\/(www\.)?youtube\.com\/(c\/|channel\/|@|user\/)[^/"'\s?#]+/gi,
  tiktok: /https?:\/\/(www\.)?tiktok\.com\/@[^/"'\s?#]+/gi,
};

const EXCLUDED_SOCIAL_SEGMENTS = ["/sharer/", "/share?", "/intent/tweet", "addtoany", "shareaholic", "/plugins/", "/dialog/"];

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const EXCLUDED_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "example.com",
  "sentry.io",
  "wixpress.com",
  "cloudflare.com",
  "w3.org",
  "schema.org",
  "googleusercontent.com",
]);

const PREFERRED_PREFIXES = ["info", "hello", "contact", "support", "sales", "team", "admin", "press", "media", "partnerships"];

const normalizeUrl = (raw: string): string => {
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
};

const isExcludedSocialUrl = (url: string): boolean => {
  const lower = url.toLowerCase();
  if (EXCLUDED_SOCIAL_SEGMENTS.some((segment) => lower.includes(segment))) {
    return true;
  }

  try {
    const parsed = new URL(url);
    return parsed.pathname === "/";
  } catch {
    return false;
  }
};

const pickFirstSocial = (html: string, pattern: RegExp): string | null => {
  const matches = html.match(pattern) ?? [];
  const unique = new Set<string>();

  for (const match of matches) {
    const normalized = normalizeUrl(match);
    if (isExcludedSocialUrl(normalized)) {
      continue;
    }

    if (!unique.has(normalized)) {
      unique.add(normalized);
      return normalized;
    }
  }

  return null;
};

const extractBusinessEmail = (html: string, expectedDomain: string | null): string | null => {
  const matches = html.match(EMAIL_REGEX) ?? [];
  const emails = matches
    .map((email) => email.toLowerCase())
    .filter((email) => {
      const domain = email.split("@")[1] || "";
      return !EXCLUDED_DOMAINS.has(domain);
    });

  if (emails.length === 0) {
    return null;
  }

  if (expectedDomain) {
    const sameDomain = emails.find((email) => email.endsWith(`@${expectedDomain}`));
    if (sameDomain) {
      return sameDomain;
    }
  }

  for (const prefix of PREFERRED_PREFIXES) {
    const found = emails.find((email) => email.startsWith(`${prefix}@`));
    if (found) {
      return found;
    }
  }

  return emails[0];
};

export async function scrapeWebsite(externalLink: string): Promise<WebsiteScrapeResult> {
  if (!externalLink) {
    return {
      fetched: false,
      sourceNotes: "External Link missing",
      socials: { linkedin: null, x: null, instagram: null, facebook: null, youtube: null, tiktok: null },
      businessEmail: null,
    };
  }

  try {
    const response = await axios.get<ArrayBuffer>(externalLink, {
      timeout: 10_000,
      maxRedirects: 3,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate",
      },
      responseType: "arraybuffer",
      validateStatus: (status: number) => status >= 200 && status < 600,
    });

    if ([403, 503].includes(response.status)) {
      return {
        fetched: false,
        sourceNotes: `Website blocked (status ${response.status})`,
        socials: { linkedin: null, x: null, instagram: null, facebook: null, youtube: null, tiktok: null },
        businessEmail: null,
      };
    }

    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("text/html")) {
      return {
        fetched: false,
        sourceNotes: `Skipped non-HTML content-type: ${contentType || "unknown"}`,
        socials: { linkedin: null, x: null, instagram: null, facebook: null, youtube: null, tiktok: null },
        businessEmail: null,
      };
    }

    let html = Buffer.from(response.data).toString("utf8");
    if (Buffer.byteLength(html, "utf8") > 5 * 1024 * 1024) {
      html = Buffer.from(response.data).subarray(0, 5 * 1024 * 1024).toString("utf8");
    }

    const socials = {
      linkedin: pickFirstSocial(html, SOCIAL_PATTERNS.linkedin),
      x: pickFirstSocial(html, SOCIAL_PATTERNS.x),
      instagram: pickFirstSocial(html, SOCIAL_PATTERNS.instagram),
      facebook: pickFirstSocial(html, SOCIAL_PATTERNS.facebook),
      youtube: pickFirstSocial(html, SOCIAL_PATTERNS.youtube),
      tiktok: pickFirstSocial(html, SOCIAL_PATTERNS.tiktok),
    };

    const businessEmail = extractBusinessEmail(html, extractDomain(externalLink));

    return {
      fetched: true,
      sourceNotes: "",
      socials,
      businessEmail,
    };
  } catch (error) {
    return {
      fetched: false,
      sourceNotes: error instanceof Error ? error.message : "Website fetch failed",
      socials: { linkedin: null, x: null, instagram: null, facebook: null, youtube: null, tiktok: null },
      businessEmail: null,
    };
  }
}

export const __testables__ = {
  pickFirstSocial,
  extractBusinessEmail,
};
