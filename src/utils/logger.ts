export type LogLevel = "info" | "warn" | "error";

const write = (level: LogLevel, message: string): void => {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] [${level}] ${message}\n`);
};

export const logger = {
  info: (message: string): void => write("info", message),
  warn: (message: string): void => write("warn", message),
  error: (message: string): void => write("error", message),
};
