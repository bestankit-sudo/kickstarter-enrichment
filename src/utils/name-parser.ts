export type ParsedName = {
  firstName: string;
  lastName: string;
};

const COMPANY_HINTS = /\b(team|inc|llc|ltd|co\.|group|studio|labs)\b/i;
const TITLE_PREFIX = /^(dr\.|mr\.|ms\.|mrs\.|prof\.)\s+/i;

const parseSingleName = (input: string): ParsedName | null => {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (COMPANY_HINTS.test(trimmed)) {
    return null;
  }

  const withoutTitle = trimmed.replace(TITLE_PREFIX, "").trim();
  if (!withoutTitle) {
    return null;
  }

  const normalized = withoutTitle.replace(/\s+/g, " ");
  const [firstName, ...rest] = normalized.split(" ");
  if (!firstName) {
    return null;
  }

  return {
    firstName,
    lastName: rest.join(" "),
  };
};

export function parseFounderNames(input: string): ParsedName[] {
  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }

  const candidates = trimmed
    .replace(/\s+and\s+/gi, ",")
    .replace(/\s*&\s*/g, ",")
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean);

  const parsed = candidates
    .map((candidate) => parseSingleName(candidate))
    .filter((item): item is ParsedName => Boolean(item));

  const deduped = new Map<string, ParsedName>();
  for (const person of parsed) {
    const key = `${person.firstName.toLowerCase()}|${person.lastName.toLowerCase()}`;
    if (!deduped.has(key)) {
      deduped.set(key, person);
    }
  }

  return Array.from(deduped.values());
}

export function parseFounderName(input: string): ParsedName | null {
  return parseFounderNames(input)[0] ?? null;
}
