import pino from "pino";

/**
 * Structured JSON logging with requestId/eventId propagation (architecture.md §7,
 * engineering-standards.md §5). Every service gets one via this factory so field
 * names stay uniform: ts, level, module, msg, plus call-site context.
 */
export function createLogger(module: string) {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { module },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
