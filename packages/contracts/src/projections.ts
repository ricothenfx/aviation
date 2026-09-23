import { z } from "zod";

import { taskStateSchema, alertSeveritySchema } from "./events";

/**
 * Read-model (projection) schemas (data-model.md §2–3, api-contracts.md §1 GET /board,
 * /flights/{id}). Added in F2 as an ADDITIVE extension: the F1 board snapshot only ever
 * carried `flights: []`, which still validates against these schemas (contracts are
 * never broken in place — engineering-standards.md §4).
 */

const uuid = z.string().uuid();
const isoTs = z.string().datetime({ offset: true });

export const flightStatusSchema = z.enum([
  "scheduled",
  "in_block",
  "turnaround",
  "off_block",
  "delayed",
]);
export type FlightStatus = z.infer<typeof flightStatusSchema>;

export const taskProjectionSchema = z.object({
  id: uuid,
  flightId: uuid,
  type: z.string().min(1),
  state: taskStateSchema,
  slaMinutes: z.number().int().positive(),
  plannedStart: isoTs,
  plannedEnd: isoTs,
});
export type TaskProjection = z.infer<typeof taskProjectionSchema>;

export const flightProjectionSchema = z.object({
  id: uuid,
  flightNo: z.string().min(1),
  standId: uuid,
  standCode: z.string().min(1),
  aircraftTypeCode: z.string().min(1),
  schedInBlock: isoTs,
  schedOffBlock: isoTs,
  /** Projection-maintained (data-model.md §2). */
  estOffBlock: isoTs.nullable(),
  status: flightStatusSchema,
  /** Minutes of projected delay vs schedOffBlock (0 when on time). */
  delayedMin: z.number().int(),
  tasks: z.array(taskProjectionSchema),
});
export type FlightProjection = z.infer<typeof flightProjectionSchema>;

export const alertProjectionSchema = z.object({
  id: uuid,
  flightId: uuid,
  ruleId: z.string().min(1),
  severity: alertSeveritySchema,
  state: z.enum(["raised", "acknowledged", "resolved"]),
  raisedAt: isoTs,
  leadTimeMin: z.number().nullable(),
});
export type AlertProjection = z.infer<typeof alertProjectionSchema>;

export const kpisSchema = z.object({
  onTimeDepPct: z.number(),
  avgTurnMin: z.number(),
  activeAlerts: z.number().int(),
  delayMinutesSaved: z.number(),
});
export type Kpis = z.infer<typeof kpisSchema>;

/** Replan proposal as exposed over REST (api-contracts.md §1 replans). F3. */
export const replanSchema = z.object({
  id: uuid,
  flightId: uuid,
  status: z.enum(["proposed", "approved", "rejected"]),
  delta: z.array(
    z.object({
      taskId: uuid,
      newStart: isoTs,
      newEnd: isoTs,
    }),
  ),
  totalDelayMin: z.number(),
  baselineDelayMin: z.number().nullable(),
  rationale: z.string().min(1),
  planHash: z.string().nullable(),
  computedAt: isoTs,
});
export type Replan = z.infer<typeof replanSchema>;

/**
 * GET /api/v1/replans/{id}/explanation (api-contracts.md §1, PRD F-4, ADR-0003).
 * F4. `source` is the honesty label: "llm" when the gateway served the answer,
 * "rules" after graceful degradation to the deterministic rationale — the
 * constraint engine always decided the schedule, the copilot only narrates it.
 * `provider` names the gateway provider ("mock" offline) or null for rules.
 */
export const replanExplanationSchema = z.object({
  replanId: uuid,
  source: z.enum(["llm", "rules"]),
  provider: z.string().nullable(),
  text: z.string().min(1),
  generatedAt: isoTs,
});
export type ReplanExplanation = z.infer<typeof replanExplanationSchema>;

/** GET /api/v1/flights/{id} (api-contracts.md §1): flight + tasks + alert lifecycle. */
export const flightDetailSchema = z.object({
  flight: flightProjectionSchema,
  alerts: z.array(alertProjectionSchema),
});
export type FlightDetail = z.infer<typeof flightDetailSchema>;

// ---------------------------------------------------------------------------
// Scenario control (api-contracts.md §1 Scenarios — supervisor only)
// ---------------------------------------------------------------------------

export const scenarioSpeedSchema = z.union([z.literal(1), z.literal(5), z.literal(20)]);
export type ScenarioSpeed = z.infer<typeof scenarioSpeedSchema>;

export const scenarioStateSchema = z.object({
  scenarioId: z.string().min(1),
  status: z.enum(["idle", "running", "completed"]),
  speed: scenarioSpeedSchema,
  /** Current scenario clock reading; null while idle. */
  scenarioNow: isoTs.nullable(),
  /** sha256 over the canonical event log — changes on every reset (PRD F-5). */
  logHash: z.string().nullable(),
});
export type ScenarioState = z.infer<typeof scenarioStateSchema>;

export const scenarioSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  state: scenarioStateSchema,
});
export type ScenarioSummary = z.infer<typeof scenarioSummarySchema>;

export const scenarioStartRequestSchema = z.object({ speed: scenarioSpeedSchema });
export type ScenarioStartRequest = z.infer<typeof scenarioStartRequestSchema>;

export const scenarioResetResponseSchema = z.object({ scenario: scenarioStateSchema });
export type ScenarioResetResponse = z.infer<typeof scenarioResetResponseSchema>;

/** One scripted disruption as listed by GET /api/v1/scenarios (PRD F-5). F4 (additive). */
export const disruptionSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  targetTaskType: z.string().min(1),
});
export type DisruptionSummary = z.infer<typeof disruptionSummarySchema>;

/**
 * F4 extends this ADDITIVELY: `disruptions` (the injectable script catalog for
 * the scenario console) defaults to [] so F3 payloads still validate unchanged.
 */
export const scenarioListResponseSchema = z.object({
  scenarios: z.array(scenarioSummarySchema),
  disruptions: z.array(disruptionSummarySchema).default([]),
});
export type ScenarioListResponse = z.infer<typeof scenarioListResponseSchema>;

// ---------------------------------------------------------------------------
// Realtime handshake (api-contracts.md §3 + architecture.md §5)
// ---------------------------------------------------------------------------

/** POST /api/v1/auth/ws-token response: short-lived JWT + gateway ws URL. */
export const wsTokenResponseSchema = z.object({
  token: z.string().min(1),
  url: z.string().min(1),
});
export type WsTokenResponse = z.infer<typeof wsTokenResponseSchema>;

/** Client → gateway control frames. Server → client frames use wsFrameSchema. */
export const wsClientMessageSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("subscribe"), channel: z.string().min(1) }),
  z.object({ action: z.literal("unsubscribe"), channel: z.string().min(1) }),
]);
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;
