import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  aggregateTypeSchema,
  eventPayloadSchemas,
  eventTypeSchema,
  type AggregateType,
  type EventPayloadMap,
  type EventType,
} from "@aviation/contracts";

import type * as schema from "@/db/schema";
import { auditEvents, eventLog } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";

/**
 * Web-side event append (engineering-standards.md §4): the web app is the
 * producer for UI-originated events (`flight.disrupted` via scenario inject,
 * `offer.confirmed` via confirm). Payloads are validated against the typed
 * zod schemas before insert; sequence is monotonic per aggregate with the
 * unique (aggregate_id, sequence) index as the race backstop. Appends accept
 * a transaction executor so state changes and their events commit atomically.
 */

export type DbExecutor =
  | NodePgDatabase<typeof schema>
  | Parameters<Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]>[0];

export interface AppendedEvent {
  id: string;
  eventId: string;
}

export async function appendEvent<T extends EventType>(
  event: {
    type: T;
    aggregateType: AggregateType;
    aggregateId: string;
    payload: EventPayloadMap[T];
  },
  exec: DbExecutor = getSingletonDb(),
): Promise<AppendedEvent> {
  // Producer-side validation (api-contracts.md §2): invalid payloads never
  // enter the log.
  const payload = eventPayloadSchemas[event.type].parse(event.payload);
  eventTypeSchema.parse(event.type);
  aggregateTypeSchema.parse(event.aggregateType);

  const [row] = await exec
    .insert(eventLog)
    .values({
      type: event.type,
      occurredAt: new Date(),
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      sequence: sql`(coalesce((select max(sequence) from event_log where aggregate_id = ${event.aggregateId}), 0) + 1)`,
      payload,
    })
    .returning({ id: eventLog.id });
  if (!row) throw new Error(`event append returned no row for ${event.type}`);
  return { id: row.id, eventId: row.id };
}

/** Append-only decision trail (PRD F-7): who did what for whom, when. */
export async function appendAuditEvent(
  entry: {
    actorId: string;
    actorRole: "passenger" | "agent" | "supervisor";
    action: string;
    targetType: string;
    targetId: string;
    details?: Record<string, unknown>;
  },
  exec: DbExecutor = getSingletonDb(),
): Promise<void> {
  await exec.insert(auditEvents).values(entry);
}
