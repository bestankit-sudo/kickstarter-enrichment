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
  contactFormUrl: string | null;
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

const CONTACT_FORM_PATTERNS = [
  /href=["']([^"']*(?:contact|get-in-touch|reach-us|connect)[^"']*)["']/gi,
];

const fetchPage = async (url: string): Promise<{ ok: boolean; html: string }> => {
  try {
    const response = await axios.get<ArrayBuffer>(url, {
      timeout: 10_000,
      maxRedirects: 3,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate",
      },
      responseType: "arraybuffer",
      validateStatus: (status: number) => status >= 200 && status < 400,
    });

    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("text/html")) return { ok: false, html: "" };

    let html = Buffer.from(response.data).toString("utf8");
    if (Buffer.byteLength(html, "utf8") > 5 * 1024 * 1024) {
      html = Buffer.from(response.data).subarray(0, 5 * 1024 * 1024).toString("utf8");
    }
    return { ok: true, html };
  } catch {
    return { ok: false, html: "" };
  }
};

const extractContactFormUrl = (html: string, baseUrl: string): string | null => {
  for (const pattern of CONTACT_FORM_PATTERNS) {
    const matches = html.matchAll(pattern);
    for (const m of matches) {
      const href = m[1];
      if (!href || href.startsWith("#") || href.startsWith("javascript")) continue;
      try {
        return new URL(href, baseUrl).toString();
      } catch {
        continue;
      }
    }
  }
  return null;
};

export async function scrapeWebsite(externalLink: string): Promise<WebsiteScrapeResult> {
  if (!externalLink) {
    return {
      fetched: false,
      sourceNotes: "External Link missing",
      socials: { linkedin: null, x: null, instagram: null, facebook: null, youtube: null, tiktok: null },
      businessEmail: null,
      contactFormUrl: null,
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
        contactFormUrl: null,
      };
    }

    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("text/html")) {
      return {
        fetched: false,
        sourceNotes: `Skipped non-HTML content-type: ${contentType || "unknown"}`,
        socials: { linkedin: null, x: null, instagram: null, facebook: null, youtube: null, tiktok: null },
        businessEmail: null,
        contactFormUrl: null,
      };
    }

    let html = Buffer.from(response.data).toString("utf8");
    if (Buffer.byteLength(html, "utf8") > 5 * 1024 * 1024) {
      html = Buffer.from(response.data).subarray(0, 5 * 1024 * 1024).toString("utf8");
    }

    const expectedDomain = extractDomain(externalLink);

    // Extract from homepage
    const socials = {
      linkedin: pickFirstSocial(html, SOCIAL_PATTERNS.linkedin),
      x: pickFirstSocial(html, SOCIAL_PATTERNS.x),
      instagram: pickFirstSocial(html, SOCIAL_PATTERNS.instagram),
      facebook: pickFirstSocial(html, SOCIAL_PATTERNS.facebook),
      youtube: pickFirstSocial(html, SOCIAL_PATTERNS.youtube),
      tiktok: pickFirstSocial(html, SOCIAL_PATTERNS.tiktok),
    };

    let businessEmail = extractBusinessEmail(html, expectedDomain);
    let contactFormUrl = extractContactFormUrl(html, externalLink);

    // If homepage is missing email or socials, try sub-pages
    const hasSocials = Object.values(socials).some(Boolean);
    if (!businessEmail || !hasSocials) {
      const baseUrl = new URL(externalLink).origin;
      const subPaths = ["/contact", "/contact-us", "/about", "/about-us", "/pages/contact"];

      for (const path of subPaths) {
        const subUrl = `${baseUrl}${path}`;
        const sub = await fetchPage(subUrl);
        if (!sub.ok) continue;

        if (!businessEmail) {
          businessEmail = extractBusinessEmail(sub.html, expectedDomain);
        }
        if (!contactFormUrl) {
          contactFormUrl = extractContactFormUrl(sub.html, subUrl);
          // If the sub-page itself is a contact page and has a form, use it
          if (!contactFormUrl && sub.html.includes("<form")) {
            contactFormUrl = subUrl;
          }
        }
        for (const [key, pattern] of Object.entries(SOCIAL_PATTERNS)) {
          if (!socials[key as keyof typeof socials]) {
            socials[key as keyof typeof socials] = pickFirstSocial(sub.html, pattern);
          }
        }

        // Stop early if we found what we need
        if (businessEmail && hasSocials) break;
      }
    }

    return {
      fetched: true,
      sourceNotes: "",
      socials,
      businessEmail,
      contactFormUrl,
    };
  } catch (error) {
    return {
      fetched: false,
      sourceNotes: error instanceof Error ? error.message : "Website fetch failed",
      socials: { linkedin: null, x: null, instagram: null, facebook: null, youtube: null, tiktok: null },
      businessEmail: null,
      contactFormUrl: null,
    };
  }
}

export const __testables__ = {
  pickFirstSocial,
  extractBusinessEmail,
};
