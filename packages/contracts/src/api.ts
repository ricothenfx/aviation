import { z } from "zod";

/**
 * Board snapshot (api-contracts.md §1 GET /api/v1/board) — REST fallback when WS is down.
 * F1 ships the envelope with empty collections; the F2 schema adds flight/task projections
 * and is expected to EXTEND this schema (additive, non-breaking).
 */
export const boardSnapshotSchema = z.object({
  generatedAt: z.string().datetime({ offset: true }),
  scenarioTs: z.string().datetime({ offset: true }).nullable(),
  live: z.boolean(),
  flights: z.array(z.never()),
  kpis: z
    .object({
      onTimeDepPct: z.number(),
      avgTurnMin: z.number(),
      activeAlerts: z.number().int(),
      delayMinutesSaved: z.number(),
    })
    .nullable(),
});
export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>;

/** Session user as returned by POST /api/v1/auth/login (api-contracts.md §1). */
export const sessionUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  role: z.enum(["viewer", "coordinator", "supervisor"]),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const loginResponseSchema = z.object({
  user: sessionUserSchema,
  token: z.string().min(1),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;
