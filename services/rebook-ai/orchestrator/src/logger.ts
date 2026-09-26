import pino from "pino";

/** Structured JSON logging (rebook-ai architecture.md §7) — same shape as the other services. */
export function createLogger(module: string) {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { module },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
