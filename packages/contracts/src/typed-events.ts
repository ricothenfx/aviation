import { z } from "zod";

import { domainEventSchema, type DomainEvent, type EventType } from "./envelope";
import {
  alertLifecyclePayloadSchema,
  bookingIssuedPayloadSchema,
  eventPayloadSchemas,
  flightDelayRiskPayloadSchema,
  flightDisruptedPayloadSchema,
  kpiUpdatedPayloadSchema,
  notificationSentPayloadSchema,
  offerConfirmedPayloadSchema,
  offerCreatedPayloadSchema,
  offerExpiredPayloadSchema,
  proposalApprovedPayloadSchema,
  proposalCreatedPayloadSchema,
  proposalRejectedPayloadSchema,
  replanApprovedPayloadSchema,
  replanProposedPayloadSchema,
  replanRejectedPayloadSchema,
  sagaCompensatedPayloadSchema,
  sagaFailedPayloadSchema,
  sagaStepCompletedPayloadSchema,
  scenarioTickPayloadSchema,
  taskRescheduledPayloadSchema,
  taskStateChangedPayloadSchema,
  turnStartedPayloadSchema,
  voucherIssuedPayloadSchema,
  type EventPayloadMap,
} from "./events";

const baseEventSchema = domainEventSchema.omit({ type: true, payload: true });

type TypedDomainEvent<K extends EventType> = z.ZodType<
  DomainEvent & { type: K; payload: EventPayloadMap[K] }
>;

function typedEvent<K extends EventType>(
  type: K,
  payload: z.ZodType<EventPayloadMap[K]>,
): TypedDomainEvent<K> {
  return baseEventSchema.extend({
    type: z.literal(type),
    payload,
  }) as unknown as TypedDomainEvent<K>;
}

/**
 * Full envelope + payload validation per event type. Used by producers (simulator,
 * replan engine) before append and by consumers (projection worker) before apply.
 */
export const typedDomainEventSchemas: { [K in EventType]: TypedDomainEvent<K> } = {
  "turn.started": typedEvent("turn.started", turnStartedPayloadSchema),
  "task.state_changed": typedEvent("task.state_changed", taskStateChangedPayloadSchema),
  "task.rescheduled": typedEvent("task.rescheduled", taskRescheduledPayloadSchema),
  "flight.delay_risk": typedEvent("flight.delay_risk", flightDelayRiskPayloadSchema),
  "alert.raised": typedEvent("alert.raised", alertLifecyclePayloadSchema),
  "alert.acknowledged": typedEvent("alert.acknowledged", alertLifecyclePayloadSchema),
  "alert.resolved": typedEvent("alert.resolved", alertLifecyclePayloadSchema),
  "replan.proposed": typedEvent("replan.proposed", replanProposedPayloadSchema),
  "replan.approved": typedEvent("replan.approved", replanApprovedPayloadSchema),
  "replan.rejected": typedEvent("replan.rejected", replanRejectedPayloadSchema),
  "kpi.updated": typedEvent("kpi.updated", kpiUpdatedPayloadSchema),
  "scenario.tick": typedEvent("scenario.tick", scenarioTickPayloadSchema),
  // rebook-ai (rebook-ai api-contracts.md §2 — additive, D-11/D-14 precedent)
  "flight.disrupted": typedEvent("flight.disrupted", flightDisruptedPayloadSchema),
  "offer.created": typedEvent("offer.created", offerCreatedPayloadSchema),
  "offer.expired": typedEvent("offer.expired", offerExpiredPayloadSchema),
  "offer.confirmed": typedEvent("offer.confirmed", offerConfirmedPayloadSchema),
  "saga.step.completed": typedEvent("saga.step.completed", sagaStepCompletedPayloadSchema),
  "saga.failed": typedEvent("saga.failed", sagaFailedPayloadSchema),
  "saga.compensated": typedEvent("saga.compensated", sagaCompensatedPayloadSchema),
  "booking.issued": typedEvent("booking.issued", bookingIssuedPayloadSchema),
  "voucher.issued": typedEvent("voucher.issued", voucherIssuedPayloadSchema),
  "notification.sent": typedEvent("notification.sent", notificationSentPayloadSchema),
  "proposal.created": typedEvent("proposal.created", proposalCreatedPayloadSchema),
  "proposal.approved": typedEvent("proposal.approved", proposalApprovedPayloadSchema),
  "proposal.rejected": typedEvent("proposal.rejected", proposalRejectedPayloadSchema),
};

export function parseTypedEvent<K extends EventType>(
  type: K,
  raw: unknown,
): DomainEvent & { type: K; payload: EventPayloadMap[K] } {
  const schema = typedDomainEventSchemas[type] as z.ZodType;
  return schema.parse(raw) as DomainEvent & { type: K; payload: EventPayloadMap[K] };
}

export { eventPayloadSchemas };
