import { z } from "zod";

/**
 * Replan-engine control commands (api-contracts.md §1 POST /flights/{id}/replan):
 * REST publishes on chan:replan:control, the engine computes from the event log
 * (architecture.md §2 — decisions never read Redis) and answers via a result key
 * (redis-keys.ts replanResultKey) that the caller polls. Control-plane only.
 */
export const replanControlCommandSchema = z.object({
  action: z.literal("propose"),
  requestId: z.string().min(1),
  flightId: z.string().uuid(),
});

export type ReplanControlCommand = z.infer<typeof replanControlCommandSchema>;

/** Engine → REST reply stored at replanResultKey(requestId) with a short TTL. */
export const replanResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    replanId: z.string().uuid(),
    planHash: z.string().min(1),
    totalDelayMin: z.number(),
    baselineDelayMin: z.number(),
    rationale: z.string().min(1),
    delta: z.array(
      z.object({ taskId: z.string().uuid(), newStart: z.string(), newEnd: z.string() }),
    ),
  }),
  z.object({
    ok: z.literal(false),
    conflicts: z.array(z.string().min(1)),
  }),
]);

export type ReplanResult = z.infer<typeof replanResultSchema>;
