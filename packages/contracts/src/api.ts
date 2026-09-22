import { z } from "zod";

import { flightProjectionSchema, kpisSchema } from "./projections";

/**
 * Board snapshot (api-contracts.md §1 GET /api/v1/board) — REST fallback when WS is down.
 * F2 extends this schema ADDITIVELY (never broken): `flights` now carries full flight
 * projections and `kpis` the PRD F-6 strip. F1 consumers that only ever saw empty
 * flights + null kpis still validate unchanged.
 */
export const boardSnapshotSchema = z.object({
  generatedAt: z.string().datetime({ offset: true }),
  scenarioTs: z.string().datetime({ offset: true }).nullable(),
  live: z.boolean(),
  flights: z.array(flightProjectionSchema),
  kpis: kpisSchema.nullable(),
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
