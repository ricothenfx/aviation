import pino from "pino";

/**
 * Structured JSON logging for the Next.js app (architecture.md §7,
 * engineering-standards.md §5). requestId/eventId propagate as call-site fields.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { module: "api" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
