export const titleProp = (value: string): { title: Array<{ text: { content: string } }> } => ({
  title: [{ text: { content: value || "Untitled" } }],
});

export const richTextProp = (value: string): { rich_text: Array<{ text: { content: string } }> } => ({
  rich_text: value ? [{ text: { content: truncateForNotion(value) } }] : [],
});

export const urlProp = (value: string | null | undefined): { url: string | null } => ({
  url: value || null,
});

export const emailProp = (value: string | null | undefined): { email: string | null } => ({
  email: value || null,
});

export const numberProp = (value: number | null | undefined): { number: number | null } => ({
  number: value ?? null,
});

export const selectProp = (value: string | null | undefined): { select: { name: string } | null } => ({
  select: value ? { name: value } : null,
});

export const dateProp = (iso: string): { date: { start: string } } => ({
  date: { start: iso },
});

export const relationProp = (pageId: string | null | undefined): { relation: Array<{ id: string }> } => ({
  relation: pageId ? [{ id: pageId }] : [],
});

export const truncateForNotion = (value: string, max = 2000): string => {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 3)}...`;
};
