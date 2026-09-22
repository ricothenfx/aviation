import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  applyRawEvent,
  buildEventsUpTo,
  buildReferenceDay,
  deriveKpis,
  eventLogHash,
  initialStateFromReferenceDay,
} from "@aviation/tiq-domain";

/**
 * Regenerates the committed golden fixture for the ADR-0001 compliance test.
 * Pure computation (no DB) — deterministic by construction. Run:
 *   pnpm --filter @aviation/tiq-realtime-gateway exec tsx scripts/generate-golden.ts
 * Commit the result; only regenerate deliberately (e.g. reference day changes).
 */
const day = buildReferenceDay();
const events = buildEventsUpTo(day, Date.parse("2026-09-22T21:00:00Z"));
const state = initialStateFromReferenceDay(day);
for (const event of events) applyRawEvent(state, event);

const golden = {
  emptyLogHash: eventLogHash([]),
  fullLogHash: eventLogHash(events),
  eventCount: events.length,
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

const outPath = path.resolve(import.meta.dirname, "../test/golden/reference-day-golden.json");
writeFileSync(outPath, `${JSON.stringify(golden, null, 2)}\n`);
console.info(
  JSON.stringify({
    module: "generate-golden",
    msg: "golden written",
    outPath,
    eventCount: events.length,
  }),
);
