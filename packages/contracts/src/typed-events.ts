import { z } from "zod";

import { domainEventSchema, type DomainEvent, type EventType } from "./envelope";
import {
  alertLifecyclePayloadSchema,
  eventPayloadSchemas,
  flightDelayRiskPayloadSchema,
  kpiUpdatedPayloadSchema,
  replanProposedPayloadSchema,
  scenarioTickPayloadSchema,
  taskStateChangedPayloadSchema,
  turnStartedPayloadSchema,
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
  "flight.delay_risk": typedEvent("flight.delay_risk", flightDelayRiskPayloadSchema),
  "alert.raised": typedEvent("alert.raised", alertLifecyclePayloadSchema),
  "alert.acknowledged": typedEvent("alert.acknowledged", alertLifecyclePayloadSchema),
  "alert.resolved": typedEvent("alert.resolved", alertLifecyclePayloadSchema),
  "replan.proposed": typedEvent("replan.proposed", replanProposedPayloadSchema),
  "kpi.updated": typedEvent("kpi.updated", kpiUpdatedPayloadSchema),
  "scenario.tick": typedEvent("scenario.tick", scenarioTickPayloadSchema),
};

export function parseTypedEvent<K extends EventType>(
  type: K,
  raw: unknown,
): DomainEvent & { type: K; payload: EventPayloadMap[K] } {
  const schema = typedDomainEventSchemas[type] as z.ZodType;
  return schema.parse(raw) as DomainEvent & { type: K; payload: EventPayloadMap[K] };
}

export { eventPayloadSchemas };
