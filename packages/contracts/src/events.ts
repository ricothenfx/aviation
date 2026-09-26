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
  /** Recovery instant while blocked (disruption scripts, F3 — additive optional). */
  blockedUntil: isoTs.optional(),
  /** Stand-release deadline carried by the blocking event (gate swap, F3). */
  standCurfew: isoTs.optional(),
});
export type TaskStateChangedPayload = z.infer<typeof taskStateChangedPayloadSchema>;

/**
 * Approved-plan application (architecture.md §3 step 5). Emitted by the replan
 * engine, one event per moved remaining task; consumers shift the planned window
 * so future task events follow the new schedule. Added in F3 (additive).
 */
export const taskRescheduledPayloadSchema = z.object({
  flightId: uuid,
  taskId: uuid,
  newStart: isoTs,
  newEnd: isoTs,
  replanId: uuid,
});
export type TaskRescheduledPayload = z.infer<typeof taskRescheduledPayloadSchema>;

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
  /** Task the projection blamed (dedup key half — F3, additive optional). */
  causeTaskId: uuid.optional(),
  /** Acting user for lifecycle transitions (audit trail, F3 — additive optional). */
  actor: z.string().email().optional(),
  /** Resolver note (api-contracts.md §1 POST /alerts/{id}/resolve {note}). F3, optional. */
  note: z.string().max(500).optional(),
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
  /** Projected departure slip of the do-nothing (unmanaged) cascade, minutes. F3, optional. */
  baselineDelayMin: z.number().optional(),
  /** sha256 over the canonical assignment list — determinism evidence (F3 DoD). */
  planHash: z.string().min(1).optional(),
});
export type ReplanProposedPayload = z.infer<typeof replanProposedPayloadSchema>;

/** Human-in-the-loop decision trail (architecture.md §3 step 5, data-model.md §2). F3. */
export const replanApprovedPayloadSchema = z.object({
  replanId: uuid,
  flightId: uuid,
  approvedBy: z.string().email(),
  appliedDelayMin: z.number(),
});
export type ReplanApprovedPayload = z.infer<typeof replanApprovedPayloadSchema>;

export const replanRejectedPayloadSchema = z.object({
  replanId: uuid,
  flightId: uuid,
  rejectedBy: z.string().email(),
  reason: z.string().min(1).max(500),
});
export type ReplanRejectedPayload = z.infer<typeof replanRejectedPayloadSchema>;

export const kpiUpdatedPayloadSchema = z.object({
  onTimeDepPct: z.number().nullable(),
  avgTurnMin: z.number().nullable(),
  activeAlerts: z.number().int(),
  delayMinutesSaved: z.number(),
});
export type KpiUpdatedPayload = z.infer<typeof kpiUpdatedPayloadSchema>;

export const scenarioTickPayloadSchema = z.object({
  scenarioTs: isoTs,
  speed: z.union([z.literal(1), z.literal(5), z.literal(20)]),
});
export type ScenarioTickPayload = z.infer<typeof scenarioTickPayloadSchema>;

// --- rebook-ai event payloads (rebook-ai api-contracts.md §2, additive) ------

export const disruptionKindSchema = z.enum(["cancellation", "long_delay"]);
export type DisruptionKind = z.infer<typeof disruptionKindSchema>;

export const sagaStepSchema = z.enum(["seat_reserve", "payment", "ticket_issue"]);
export type SagaStep = z.infer<typeof sagaStepSchema>;

export const rebookRoleSchema = z.enum(["passenger", "agent", "supervisor"]);
export type RebookRole = z.infer<typeof rebookRoleSchema>;

export const flightDisruptedPayloadSchema = z.object({
  flightNo: z.string().min(1),
  disruptionKind: disruptionKindSchema,
  delayMinutes: z.number().int().nonnegative(),
  reasonCode: z.string().min(1),
  affectedPnrs: z.number().int().nonnegative(),
});
export type FlightDisruptedPayload = z.infer<typeof flightDisruptedPayloadSchema>;

export const offerCreatedPayloadSchema = z.object({
  pnrId: uuid,
  offerId: uuid,
  optionCount: z.number().int().positive(),
  voucherIssued: z.boolean(),
});
export type OfferCreatedPayload = z.infer<typeof offerCreatedPayloadSchema>;

export const offerExpiredPayloadSchema = z.object({
  offerId: uuid,
  reason: z.string().min(1),
});
export type OfferExpiredPayload = z.infer<typeof offerExpiredPayloadSchema>;

export const offerConfirmedPayloadSchema = z.object({
  offerId: uuid,
  optionId: uuid,
  byRole: rebookRoleSchema,
  /** Null while the saga has not been opened yet (agent-approved path). */
  sagaId: uuid.nullable(),
});
export type OfferConfirmedPayload = z.infer<typeof offerConfirmedPayloadSchema>;

export const sagaStepCompletedPayloadSchema = z.object({
  sagaId: uuid,
  step: sagaStepSchema,
  latencyMs: z.number().int().nonnegative(),
});
export type SagaStepCompletedPayload = z.infer<typeof sagaStepCompletedPayloadSchema>;

export const sagaFailedPayloadSchema = z.object({
  sagaId: uuid,
  step: sagaStepSchema,
  errorCode: z.string().min(1),
});
export type SagaFailedPayload = z.infer<typeof sagaFailedPayloadSchema>;

export const sagaCompensatedPayloadSchema = z.object({
  sagaId: uuid,
  compensatedSteps: z.array(sagaStepSchema).min(1),
});
export type SagaCompensatedPayload = z.infer<typeof sagaCompensatedPayloadSchema>;

export const bookingIssuedPayloadSchema = z.object({
  sagaId: uuid,
  pnrId: uuid,
  newFlightNo: z.string().min(1),
  boardingPassRef: z.string().min(1),
});
export type BookingIssuedPayload = z.infer<typeof bookingIssuedPayloadSchema>;

/** Criteria + evaluated values travel with the voucher — explainability (PRD F-3). */
export const voucherIssuedPayloadSchema = z.object({
  voucherId: uuid,
  pnrId: uuid,
  criteria: z.record(z.string(), z.unknown()),
});
export type VoucherIssuedPayload = z.infer<typeof voucherIssuedPayloadSchema>;

export const notificationSentPayloadSchema = z.object({
  notificationId: uuid,
  pnrId: uuid,
  channel: z.literal("inbox"),
});
export type NotificationSentPayload = z.infer<typeof notificationSentPayloadSchema>;

export const proposalCreatedPayloadSchema = z.object({
  proposalId: uuid,
  pnrId: uuid,
  /** Honesty badge pair (D-10): llm+provider vs the rules fallback. */
  source: z.enum(["llm", "rules"]),
  provider: z.string().min(1),
});
export type ProposalCreatedPayload = z.infer<typeof proposalCreatedPayloadSchema>;

export const proposalApprovedPayloadSchema = z.object({
  proposalId: uuid,
  approverId: uuid,
  note: z.string().max(500).optional(),
});
export type ProposalApprovedPayload = z.infer<typeof proposalApprovedPayloadSchema>;

export const proposalRejectedPayloadSchema = z.object({
  proposalId: uuid,
  approverId: uuid,
  note: z.string().min(1).max(500),
});
export type ProposalRejectedPayload = z.infer<typeof proposalRejectedPayloadSchema>;

export type EventPayloadMap = {
  "turn.started": TurnStartedPayload;
  "task.state_changed": TaskStateChangedPayload;
  "task.rescheduled": TaskRescheduledPayload;
  "flight.delay_risk": FlightDelayRiskPayload;
  "alert.raised": AlertLifecyclePayload;
  "alert.acknowledged": AlertLifecyclePayload;
  "alert.resolved": AlertLifecyclePayload;
  "replan.proposed": ReplanProposedPayload;
  "replan.approved": ReplanApprovedPayload;
  "replan.rejected": ReplanRejectedPayload;
  "kpi.updated": KpiUpdatedPayload;
  "scenario.tick": ScenarioTickPayload;
  "flight.disrupted": FlightDisruptedPayload;
  "offer.created": OfferCreatedPayload;
  "offer.expired": OfferExpiredPayload;
  "offer.confirmed": OfferConfirmedPayload;
  "saga.step.completed": SagaStepCompletedPayload;
  "saga.failed": SagaFailedPayload;
  "saga.compensated": SagaCompensatedPayload;
  "booking.issued": BookingIssuedPayload;
  "voucher.issued": VoucherIssuedPayload;
  "notification.sent": NotificationSentPayload;
  "proposal.created": ProposalCreatedPayload;
  "proposal.approved": ProposalApprovedPayload;
  "proposal.rejected": ProposalRejectedPayload;
};

export const eventPayloadSchemas: { [K in EventType]: z.ZodType<EventPayloadMap[K]> } = {
  "turn.started": turnStartedPayloadSchema,
  "task.state_changed": taskStateChangedPayloadSchema,
  "task.rescheduled": taskRescheduledPayloadSchema,
  "flight.delay_risk": flightDelayRiskPayloadSchema,
  "alert.raised": alertLifecyclePayloadSchema,
  "alert.acknowledged": alertLifecyclePayloadSchema,
  "alert.resolved": alertLifecyclePayloadSchema,
  "replan.proposed": replanProposedPayloadSchema,
  "replan.approved": replanApprovedPayloadSchema,
  "replan.rejected": replanRejectedPayloadSchema,
  "kpi.updated": kpiUpdatedPayloadSchema,
  "scenario.tick": scenarioTickPayloadSchema,
  "flight.disrupted": flightDisruptedPayloadSchema,
  "offer.created": offerCreatedPayloadSchema,
  "offer.expired": offerExpiredPayloadSchema,
  "offer.confirmed": offerConfirmedPayloadSchema,
  "saga.step.completed": sagaStepCompletedPayloadSchema,
  "saga.failed": sagaFailedPayloadSchema,
  "saga.compensated": sagaCompensatedPayloadSchema,
  "booking.issued": bookingIssuedPayloadSchema,
  "voucher.issued": voucherIssuedPayloadSchema,
  "notification.sent": notificationSentPayloadSchema,
  "proposal.created": proposalCreatedPayloadSchema,
  "proposal.approved": proposalApprovedPayloadSchema,
  "proposal.rejected": proposalRejectedPayloadSchema,
};
