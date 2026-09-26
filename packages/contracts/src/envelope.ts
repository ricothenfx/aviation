import { z } from "zod";

/**
 * Event vocabulary shared by the event log (ADR-0001), the realtime gateway and the UI.
 * Sources: api-contracts.md §3, data-model.md §1 (event_log.type).
 */
/**
 * F3 extends the vocabulary ADDITIVELY (never in-place mutation, api-contracts.md §3):
 * - `task.rescheduled` — emitted by the replan engine when an approved plan moves
 *   remaining tasks (architecture.md §3 step 5: "simulator adopts new schedule").
 * - `replan.approved` / `replan.rejected` — the human-in-the-loop decision trail
 *   (architecture.md §3, data-model.md §2 replan lifecycle proposed|approved|rejected).
 */
/**
 * rebook-ai joins the vocabulary ADDITIVELY (rebook-ai api-contracts.md §2, D-11/D-14
 * precedent): disruption → offers, saga fulfillment, vouchers, notifications and the
 * propose-only agent proposal lifecycle. Envelope shape is unchanged for existing
 * consumers; new types only.
 */
export const EVENT_TYPES = [
  "turn.started",
  "task.state_changed",
  "task.rescheduled",
  "flight.delay_risk",
  "alert.raised",
  "alert.acknowledged",
  "alert.resolved",
  "replan.proposed",
  "replan.approved",
  "replan.rejected",
  "kpi.updated",
  "scenario.tick",
  "flight.disrupted",
  "offer.created",
  "offer.expired",
  "offer.confirmed",
  "saga.step.completed",
  "saga.failed",
  "saga.compensated",
  "booking.issued",
  "voucher.issued",
  "notification.sent",
  "proposal.created",
  "proposal.approved",
  "proposal.rejected",
] as const;

export const eventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * rebook-ai vocabulary subset (rebook-ai api-contracts.md §2). Consumers
 * outside the rebook domain (e.g. turnaround-iq projections switch over the
 * full union) skip these defensively — they never enter foreign event logs,
 * and the skip keeps their exhaustiveness guards strict for their own types.
 */
export const REBOOK_EVENT_TYPES = [
  "flight.disrupted",
  "offer.created",
  "offer.expired",
  "offer.confirmed",
  "saga.step.completed",
  "saga.failed",
  "saga.compensated",
  "booking.issued",
  "voucher.issued",
  "notification.sent",
  "proposal.created",
  "proposal.approved",
  "proposal.rejected",
] as const satisfies readonly EventType[];

export type RebookEventType = (typeof REBOOK_EVENT_TYPES)[number];

export function isRebookEventType(type: EventType): type is RebookEventType {
  return (REBOOK_EVENT_TYPES as readonly string[]).includes(type);
}

/** turnaround-iq's own vocabulary: the shared unions minus rebook-ai's subset. */
export type TurnaroundEventType = Exclude<EventType, RebookEventType>;

export const REBOOK_AGGREGATE_TYPES = [
  "pnr",
  "offer",
  "saga",
  "voucher",
  "proposal",
  "notification",
] as const satisfies readonly AggregateType[];

export type RebookAggregateType = (typeof REBOOK_AGGREGATE_TYPES)[number];

export function isRebookAggregateType(type: AggregateType): type is RebookAggregateType {
  return (REBOOK_AGGREGATE_TYPES as readonly string[]).includes(type);
}

export type TurnaroundAggregateType = Exclude<AggregateType, RebookAggregateType>;

export const AGGREGATE_TYPES = [
  "flight",
  "task",
  "alert",
  "replan",
  "scenario",
  "pnr",
  "offer",
  "saga",
  "voucher",
  "proposal",
  "notification",
] as const;
export const aggregateTypeSchema = z.enum(AGGREGATE_TYPES);
export type AggregateType = (typeof AGGREGATE_TYPES)[number];

const isoScenarioTimestamp = z.string().datetime({ offset: true });

/**
 * Immutable event-log envelope (engineering-standards.md §4).
 * `sequence` is monotonic per aggregate and doubles as the projection idempotency key (ADR-0001).
 */
export const domainEventSchema = z.object({
  id: z.string().min(1),
  type: eventTypeSchema,
  occurredAt: isoScenarioTimestamp,
  aggregateId: z.string().uuid(),
  aggregateType: aggregateTypeSchema,
  sequence: z.number().int().positive(),
  payload: z.unknown(),
});
export type DomainEvent = z.infer<typeof domainEventSchema>;

/**
 * WebSocket frame envelope (api-contracts.md §3).
 * `lastEventId` lets clients resume after reconnect via /api/v1/events?after=.
 */
export const wsFrameSchema = z.object({
  id: z.string().min(1),
  ts: isoScenarioTimestamp,
  channel: z.string().min(1),
  type: eventTypeSchema,
  payload: z.unknown(),
  lastEventId: z.string().min(1).nullable(),
});
export type WsFrame = z.infer<typeof wsFrameSchema>;
