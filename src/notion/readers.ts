export const getTitle = (page: Record<string, unknown>, propertyName: string): string => {
  const props = page.properties as Record<string, unknown>;
  const prop = props?.[propertyName] as { title?: Array<{ plain_text?: string }> } | undefined;
  return prop?.title?.map((part) => part.plain_text ?? "").join("").trim() ?? "";
};

export const getRichText = (page: Record<string, unknown>, propertyName: string): string => {
  const props = page.properties as Record<string, unknown>;
  const prop = props?.[propertyName] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  return prop?.rich_text?.map((part) => part.plain_text ?? "").join("").trim() ?? "";
};

export const getUrl = (page: Record<string, unknown>, propertyName: string): string => {
  const props = page.properties as Record<string, unknown>;
  const prop = props?.[propertyName] as { url?: string | null } | undefined;
  return prop?.url?.trim() ?? "";
};

export const getSelect = (page: Record<string, unknown>, propertyName: string): string => {
  const props = page.properties as Record<string, unknown>;
  const prop = props?.[propertyName] as { select?: { name?: string } | null } | undefined;
  return prop?.select?.name?.trim() ?? "";
};

export const getTextOrUrl = (page: Record<string, unknown>, propertyName: string): string => {
  const props = page.properties as Record<string, unknown>;
  const prop = props?.[propertyName] as
    | {
        url?: string | null;
        rich_text?: Array<{ plain_text?: string }>;
        title?: Array<{ plain_text?: string }>;
      }
    | undefined;

  if (prop?.url) {
    return prop.url.trim();
  }

  if (prop?.rich_text?.length) {
    return prop.rich_text.map((part) => part.plain_text ?? "").join("").trim();
  }

  if (prop?.title?.length) {
    return prop.title.map((part) => part.plain_text ?? "").join("").trim();
  }

  return "";
};
