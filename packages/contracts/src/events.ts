import { z } from "zod";

import type { EventType } from "./envelope";

/**
 * Typed payloads for every event in the vocabulary (api-contracts.md §3 "Type | Payload").
 * Breaking changes to any payload = new event type version suffix, never in-place mutation.
 */

export const taskStateSchema = z.enum(["pending", "in_progress", "done", "blocked"]);
export type TaskState = z.infer<typeof taskStateSchema>;

export const alertSeveritySchema = z.enum(["info", "warning", "critical"]);
export type AlertSeverity = z.infer<typeof alertSeveritySchema>;

const uuid = z.string().uuid();
const isoTs = z.string().datetime({ offset: true });

export const turnStartedPayloadSchema = z.object({
  flightId: uuid,
  standCode: z.string().min(1),
  scenarioTs: isoTs,
});
export type TurnStartedPayload = z.infer<typeof turnStartedPayloadSchema>;

export const taskStateChangedPayloadSchema = z.object({
  flightId: uuid,
  taskId: uuid,
  state: taskStateSchema,
  scenarioTs: isoTs,
  slaRemainingMin: z.number(),
});
export type TaskStateChangedPayload = z.infer<typeof taskStateChangedPayloadSchema>;

export const flightDelayRiskPayloadSchema = z.object({
  flightId: uuid,
  projectedOffBlock: isoTs,
  delayMin: z.number(),
  causeTaskId: uuid.nullable(),
});
export type FlightDelayRiskPayload = z.infer<typeof flightDelayRiskPayloadSchema>;

export const alertLifecyclePayloadSchema = z.object({
  alertId: uuid,
  flightId: uuid,
  ruleId: z.string().min(1),
  severity: alertSeveritySchema,
  leadTimeMin: z.number().nullable(),
});
export type AlertLifecyclePayload = z.infer<typeof alertLifecyclePayloadSchema>;

export const replanProposedPayloadSchema = z.object({
  replanId: uuid,
  flightId: uuid,
  delta: z.array(
    z.object({
      taskId: uuid,
      newStart: isoTs,
      newEnd: isoTs,
    }),
  ),
  totalDelayMin: z.number(),
  rationale: z.string().min(1),
});
export type ReplanProposedPayload = z.infer<typeof replanProposedPayloadSchema>;

export const kpiUpdatedPayloadSchema = z.object({
  onTimeDepPct: z.number(),
  avgTurnMin: z.number(),
  activeAlerts: z.number().int(),
  delayMinutesSaved: z.number(),
});
export type KpiUpdatedPayload = z.infer<typeof kpiUpdatedPayloadSchema>;

export const scenarioTickPayloadSchema = z.object({
  scenarioTs: isoTs,
  speed: z.union([z.literal(1), z.literal(5), z.literal(20)]),
});
export type ScenarioTickPayload = z.infer<typeof scenarioTickPayloadSchema>;

export type EventPayloadMap = {
  "turn.started": TurnStartedPayload;
  "task.state_changed": TaskStateChangedPayload;
  "flight.delay_risk": FlightDelayRiskPayload;
  "alert.raised": AlertLifecyclePayload;
  "alert.acknowledged": AlertLifecyclePayload;
  "alert.resolved": AlertLifecyclePayload;
  "replan.proposed": ReplanProposedPayload;
  "kpi.updated": KpiUpdatedPayload;
  "scenario.tick": ScenarioTickPayload;
};

export const eventPayloadSchemas: { [K in EventType]: z.ZodType<EventPayloadMap[K]> } = {
  "turn.started": turnStartedPayloadSchema,
  "task.state_changed": taskStateChangedPayloadSchema,
  "flight.delay_risk": flightDelayRiskPayloadSchema,
  "alert.raised": alertLifecyclePayloadSchema,
  "alert.acknowledged": alertLifecyclePayloadSchema,
  "alert.resolved": alertLifecyclePayloadSchema,
  "replan.proposed": replanProposedPayloadSchema,
  "kpi.updated": kpiUpdatedPayloadSchema,
  "scenario.tick": scenarioTickPayloadSchema,
};
