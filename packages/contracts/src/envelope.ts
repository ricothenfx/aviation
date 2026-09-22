import { z } from "zod";

/**
 * Event vocabulary shared by the event log (ADR-0001), the realtime gateway and the UI.
 * Sources: api-contracts.md §3, data-model.md §1 (event_log.type).
 */
export const EVENT_TYPES = [
  "turn.started",
  "task.state_changed",
  "flight.delay_risk",
  "alert.raised",
  "alert.acknowledged",
  "alert.resolved",
  "replan.proposed",
  "kpi.updated",
  "scenario.tick",
] as const;

export const eventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = (typeof EVENT_TYPES)[number];

export const AGGREGATE_TYPES = ["flight", "task", "alert", "replan", "scenario"] as const;
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
