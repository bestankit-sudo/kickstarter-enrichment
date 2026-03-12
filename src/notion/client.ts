import { Client } from "@notionhq/client";
import { RequestQueue, sleep } from "../utils/rate-limiter.js";

type NotionFilter = Record<string, unknown>;

type QueryResult = {
  id: string;
  properties: Record<string, unknown>;
  [key: string]: unknown;
};

export class NotionService {
  private readonly client: Client;
  private readonly queue: RequestQueue;
  private readonly propertyTypeCache = new Map<string, Record<string, string>>();

  constructor(token: string) {
    this.client = new Client({ auth: token });
    this.queue = new RequestQueue(350);
  }

  private async runNotionCall<T>(fn: () => Promise<T>): Promise<T> {
    return this.queue.schedule(async () => {
      while (true) {
        try {
          return await fn();
        } catch (error) {
          if (this.isRateLimit(error)) {
            const retryAfter = this.getRetryAfterMs(error);
            await sleep(retryAfter);
            continue;
          }
          throw error;
        }
      }
    });
  }

  private isRateLimit(error: unknown): boolean {
    const value = error as { code?: string; status?: number };
    return value?.status === 429 || value?.code === "rate_limited";
  }

  private getRetryAfterMs(error: unknown): number {
    const notionError = error as {
      headers?: Record<string, string | string[]>;
    };

    const retryAfter = notionError?.headers?.["retry-after"];
    const secondsRaw = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
    const seconds = Number.parseInt(secondsRaw ?? "", 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
    return 1500;
  }

  async queryDatabase(dbId: string, filter?: NotionFilter, startCursor?: string): Promise<QueryResult[]> {
    const results: QueryResult[] = [];
    let cursor = startCursor;

    do {
      const response = await this.runNotionCall(() =>
        this.client.databases.query({
          database_id: dbId,
          page_size: 100,
          filter: filter as any,
          start_cursor: cursor,
        }),
      );
      const typedResponse = response as {
        results: unknown[];
        has_more: boolean;
        next_cursor: string | null;
      };

      results.push(...(typedResponse.results as QueryResult[]));
      cursor = typedResponse.has_more ? typedResponse.next_cursor ?? undefined : undefined;
    } while (cursor);

    return results;
  }

  async createPage(dbId: string, properties: Record<string, unknown>): Promise<QueryResult> {
    const response = await this.runNotionCall(() =>
      this.client.pages.create({
        parent: { database_id: dbId },
        properties: properties as any,
      }),
    );
    return response as QueryResult;
  }

  async updatePage(pageId: string, properties: Record<string, unknown>): Promise<QueryResult> {
    const response = await this.runNotionCall(() =>
      this.client.pages.update({
        page_id: pageId,
        properties: properties as any,
      }),
    );
    return response as QueryResult;
  }

  private async getPropertyType(dbId: string, propertyName: string): Promise<string | null> {
    const cached = this.propertyTypeCache.get(dbId);
    if (cached && cached[propertyName]) {
      return cached[propertyName];
    }

    const response = await this.runNotionCall(() =>
      this.client.databases.retrieve({
        database_id: dbId,
      }),
    );

    const typed = response as {
      properties?: Record<string, { type?: string }>;
    };
    const next: Record<string, string> = {};
    for (const [name, prop] of Object.entries(typed.properties ?? {})) {
      if (prop?.type) {
        next[name] = prop.type;
      }
    }
    this.propertyTypeCache.set(dbId, next);
    return next[propertyName] ?? null;
  }

  async searchByProperty(dbId: string, propertyName: string, value: string): Promise<QueryResult[]> {
    const type = await this.getPropertyType(dbId, propertyName);
    const filterType = type === "url" ? "url" : type === "title" ? "title" : "rich_text";
    return this.queryDatabase(dbId, {
      property: propertyName,
      [filterType]: {
        equals: value,
      },
    });
  }
}
