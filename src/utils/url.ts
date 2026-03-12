export function normalizeKickstarterUrl(raw: string): string {
  let url = raw.trim().toLowerCase();
  url = url.replace(/^https?:\/\//, "");
  url = url.replace(/^www\./, "");
  url = url.replace(/\?.*$/, "");
  url = url.replace(/#.*$/, "");
  url = url.replace(/\/+$/, "");
  return url;
}

export function extractDomain(externalLink: string): string | null {
  try {
    const parsed = new URL(externalLink);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
