import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createDb, type Db } from "@aviation/db/client";
import { upsertReferenceDay } from "@aviation/db/baseline";
import {
  applyRawEvent,
  buildEventsUpTo,
  buildReferenceDay,
  deriveKpis,
  eventLogHash,
  initialStateFromReferenceDay,
  type Kpis,
} from "@aviation/tiq-domain";
import { events as eventsTable } from "@aviation/db/schema";

import { readAllEventsOrdered, readEventsAfter } from "../../src/rebuild";

/**
 * ADR-0001 compliance test (milestones.md §F2 DoD): replay the FULL seed event
 * log through the projection handlers and assert the read model matches the
 * committed golden state. Also asserts replay determinism via the event-log hash
 * and read-back equality (log → replay is lossless).
 *
 * Requires the compose stack: DATABASE_URL + REDIS_URL (see vitest.integration.config).
 */

const __db: { value: Db | null } = { value: null };
const day = buildReferenceDay();
const DAY_END_MS = Date.parse("2026-09-22T21:00:00Z");

beforeAll(async () => {
  const { db } = createDb();
  __db.value = db;
  await upsertReferenceDay(db, day);
  await db.execute(sql`truncate table events restart identity`);
});

afterAll(async () => {
  const db = __db.value;
  if (db) await db.execute(sql`truncate table events restart identity`);
  const { close } = createDb();
  await close();
});

interface GoldenFlight {
  flightNo: string;
  status: string;
  delayedMin: number;
  estOffBlock: string | null;
  doneTasks: number;
}

interface GoldenState {
  emptyLogHash: string;
  fullLogHash: string;
  eventCount: number;
  flights: GoldenFlight[];
  kpis: Kpis;
}

describe("golden replay (ADR-0001 compliance, milestones §F2)", () => {
  it("replays the full seed log into the committed golden state", async () => {
    const db = __db.value;
    if (!db) throw new Error("db missing");
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required for integration tests");

    const emptyHash = eventLogHash([]);
    const events = buildEventsUpTo(day, DAY_END_MS);
    const fullHash = eventLogHash(events);
    expect(events).toHaveLength(1500);

    // Append via raw inserts exercising the same unique-index idempotency as the
    // simulator (ON CONFLICT DO NOTHING on aggregate_id + sequence).
    for (let i = 0; i < events.length; i += 200) {
      await db
        .insert(eventsTable)
        .values(
          events.slice(i, i + 200).map((event) => ({
            id: event.id,
            aggregateId: event.aggregateId,
            aggregateType: event.aggregateType,
            type: event.type,
            sequence: event.sequence,
            occurredAt: new Date(event.occurredAt),
            payload: event.payload,
            producer: "simulator" as const,
          })),
        )
        .onConflictDoNothing();
    }

    // Test isolation: the live replan engine tails this same log and may append
    // an alert event while the fixture streams in. The golden comparison covers
    // the seed log itself, so drop any non-simulator rows before asserting.
    await db.execute(sql`delete from events where producer <> 'simulator'`);

    const readBack = await readAllEventsOrdered(db);
    expect(readBack).toHaveLength(events.length);
    expect(eventLogHash(readBack)).toBe(fullHash);

    // Full replay through the production handlers.
    const state = initialStateFromReferenceDay(day);
    for (const event of readBack) applyRawEvent(state, event);

    const golden: GoldenState = {
      emptyLogHash: emptyHash,
      fullLogHash: fullHash,
      eventCount: readBack.length,
      flights: [...state.flights.values()]
        .sort((a, b) => a.flightNo.localeCompare(b.flightNo))
        .map((flight) => ({
          flightNo: flight.flightNo,
          status: flight.status,
          delayedMin: flight.delayedMin,
          estOffBlock: flight.estOffBlock,
          doneTasks: flight.tasks.filter((t) => t.state === "done").length,
        })),
      kpis: deriveKpis(state),
    };

    const { default: goldenFixture } = await import("../golden/reference-day-golden.json");
    expect(golden).toEqual(goldenFixture);

    // Catch-up read path returns the same ordered log (slice + cursor contract).
    const firstPage = await readEventsAfter(db, 0, 500);
    expect(firstPage).toHaveLength(500);
    expect(firstPage[499]?.seq).toBe(500);
  }, 60000);
});
