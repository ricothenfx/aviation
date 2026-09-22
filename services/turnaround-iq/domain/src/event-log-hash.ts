import { createHash } from "node:crypto";

/**
 * Canonical event-log hashing (PRD F-5: "identical event-log hash across resets";
 * F3 DoD: same seed + log ⇒ identical plan hash). The hash covers the identity
 * fields of every event in seq order — payload bytes are intentionally excluded
 * because JSONB roundtrips do not guarantee key order; the event identity
 * (id/type/time/aggregate/sequence) fully determines the log.
 */

export interface HashableEvent {
  id: string;
  type: string;
  occurredAt: string;
  aggregateId: string;
  sequence: number;
}

export function eventLogHash(events: readonly HashableEvent[]): string {
  const hash = createHash("sha256");
  for (const event of events) {
    // Epoch-millis normalize timestamp representation: PG roundtrips render
    // "…:00Z" as "…:00.000Z", and the log hash must be representation-blind.
    const occurredMs = Date.parse(event.occurredAt);
    if (Number.isNaN(occurredMs)) throw new Error(`unparseable occurredAt: ${event.occurredAt}`);
    hash.update(`${event.id}|${event.type}|${occurredMs}|${event.aggregateId}|${event.sequence}\n`);
  }
  return hash.digest("hex");
}

/** Hash of the empty log — the value reported right after a scenario reset. */
export function emptyLogHash(): string {
  return eventLogHash([]);
}
