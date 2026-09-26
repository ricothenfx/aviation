import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { events as eventsTable } from "@aviation/db/schema";
import type { AggregateType } from "@aviation/db/schema";
import { buildEventsUpTo, buildReferenceDay } from "@aviation/tiq-domain";
import type { DomainEvent } from "@aviation/contracts";

import { ProjectionWorker } from "../../src/worker";
import { openStack, type Stack } from "./helpers";

/**
 * Idempotency DoD (milestones.md §F2): duplicate delivery of any event is a
 * no-op — at the log level (unique (aggregate_id, sequence) index) and at the
 * worker level (per-aggregate watermark skip). Worker behavior is asserted on
 * the in-process worker's own projection state so the always-on container
 * worker (which mirrors the same Redis writes) cannot contaminate observations.
 */

const day = buildReferenceDay();

function taskEventAt(index: number): DomainEvent {
  const events = buildEventsUpTo(day, Date.parse("2026-09-22T06:30:00Z")).filter(
    (e) => e.type === "task.state_changed",
  );
  const event = events[index];
  if (!event) throw new Error(`fixture missing task event #${index}`);
  return event;
}

async function insertEvent(db: Stack["db"], event: DomainEvent, idSuffix = ""): Promise<number> {
  const inserted = await db
    .insert(eventsTable)
    .values({
      id: `${event.id}${idSuffix}`,
      aggregateId: event.aggregateId,
      aggregateType: event.aggregateType as AggregateType,
      type: event.type,
      sequence: event.sequence,
      occurredAt: new Date(event.occurredAt),
      payload: event.payload,
      producer: "simulator" as const,
    })
    .onConflictDoNothing()
    .returning({ seq: eventsTable.seq });
  return inserted.length;
}

function testWorker(stack: Stack): ProjectionWorker {
  return new ProjectionWorker({
    db: stack.db,
    redis: stack.redis,
    subscriber: stack.redis,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    pollIntervalMs: 60_000,
    broadcast: () => {},
  });
}

describe("event idempotency (ADR-0001)", () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await openStack();
    await stack.resetScenario();
  });

  afterAll(async () => {
    await stack.resetScenario();
    await stack.close();
  });

  it("appending a duplicate event is a no-op at the log level", async () => {
    const event = taskEventAt(0);
    expect(await insertEvent(stack.db, event)).toBe(1);
    // Same aggregate + sequence, different id: still rejected by the index.
    expect(await insertEvent(stack.db, event, ":duplicate")).toBe(0);
    expect(await insertEvent(stack.db, event)).toBe(0);
  });

  it("replaying a duplicate through the worker leaves the projection unchanged", async () => {
    const worker = testWorker(stack);
    await worker.rebuild();

    // Fresh event, not yet in the log at rebuild time.
    const event = taskEventAt(1);
    const payload = event.payload as { flightId: string; taskId: string; state: string };
    const before = worker.flightSnapshot(payload.flightId);
    const taskBefore = before?.tasks.find((t) => t.id === payload.taskId);
    expect(taskBefore?.state).toBe("pending");

    // First delivery: applies.
    await worker.ingestRaw(JSON.stringify(event));
    const afterFirst = worker.flightSnapshot(payload.flightId);
    expect(afterFirst?.tasks.find((t) => t.id === payload.taskId)?.state).toBe(payload.state);

    // Duplicate deliveries (and a re-persisted copy of the same event): no-ops.
    const once = JSON.stringify(afterFirst);
    await worker.ingestRaw(JSON.stringify(event));
    await worker.ingestRaw(JSON.stringify({ ...event, id: `${event.id}:replay` }));
    expect(JSON.stringify(worker.flightSnapshot(payload.flightId))).toBe(once);

    // The worker never writes to the append-only log: the event was applied in
    // memory only, so the first durable insert still succeeds (ADR-0001).
    expect(await insertEvent(stack.db, event)).toBe(1);
  }, 30000);
});
