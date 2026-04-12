export function extractLinkedinSlug(url: string): string | null {
  if (!url) return null;
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export function buildPersonKey(
  kickstarterUrlKey: string,
  candidate: {
    apolloPersonId?: string;
    linkedinUrl?: string;
    fullName?: string;
    source?: string;
  },
): string {
  if (candidate.apolloPersonId) {
    return `${kickstarterUrlKey}::${candidate.apolloPersonId}`;
  }

  const slug = extractLinkedinSlug(candidate.linkedinUrl ?? "");
  if (slug) {
    return `${kickstarterUrlKey}::${slug}`;
  }

  const normalizedName = (candidate.fullName ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const source = candidate.source ?? "unknown";

  return `${kickstarterUrlKey}::${normalizedName}::${source}`;
}
