export const FOUNDER_TITLES = ["founder", "co-founder", "ceo"];

export const FOUNDER_SENIORITY = ["founder", "owner", "c_suite"];

export const OPERATOR_TITLES = [
  "partnerships",
  "business development",
  "marketing",
  "community",
  "brand",
  "ceo",
  "founder",
];

export const ALL_TITLES = [...new Set([...FOUNDER_TITLES, ...OPERATOR_TITLES])];
