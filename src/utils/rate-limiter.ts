export class RequestQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly minDelayMs: number) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const startedAt = Date.now();
      try {
        return await fn();
      } finally {
        const elapsed = Date.now() - startedAt;
        const waitMs = Math.max(0, this.minDelayMs - elapsed);
        if (waitMs > 0) {
          await sleep(waitMs);
        }
      }
    });

    this.tail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  options: {
    retries: number;
    initialDelayMs: number;
    maxDelayMs: number;
    shouldRetry: (error: unknown) => boolean;
  },
): Promise<T> {
  let attempt = 0;
  let delay = options.initialDelayMs;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt > options.retries || !options.shouldRetry(error)) {
        throw error;
      }
      await sleep(delay);
      delay = Math.min(options.maxDelayMs, delay * 2);
    }
  }
}
