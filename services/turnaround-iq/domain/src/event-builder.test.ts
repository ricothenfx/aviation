import { describe, expect, it } from "vitest";

import { parseTypedEvent } from "@aviation/contracts";

import { buildEventsUpTo, buildReferenceDay, eventLogHash, emptyLogHash } from "./index";

const DAY_END_MS = Date.parse("2026-09-22T21:00:00Z");

describe("event builder (architecture.md §3, ADR-0001)", () => {
  it("is deterministic: same day + horizon ⇒ identical log (byte-level)", () => {
    const day = buildReferenceDay();
    const a = buildEventsUpTo(day, DAY_END_MS);
    const b = buildEventsUpTo(day, DAY_END_MS);
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(eventLogHash(a)).toBe(eventLogHash(b));
  });

  it("emits exactly turn.started + 2 events per task", () => {
    const day = buildReferenceDay();
    const events = buildEventsUpTo(day, DAY_END_MS);
    // 60 flights × (1 turn.started + 12 tasks × 2 transitions)
    expect(events).toHaveLength(60 * 25);
    expect(events.filter((e) => e.type === "turn.started")).toHaveLength(60);
    expect(events.filter((e) => e.type === "task.state_changed")).toHaveLength(60 * 12 * 2);
  });

  it("respects per-aggregate watermarks (idempotent re-build)", () => {
    const day = buildReferenceDay();
    const all = buildEventsUpTo(day, DAY_END_MS);
    const partial = buildEventsUpTo(day, DAY_END_MS / 2);
    const watermarks = new Map<string, number>();
    for (const event of partial) {
      watermarks.set(
        event.aggregateId,
        Math.max(watermarks.get(event.aggregateId) ?? 0, event.sequence),
      );
    }
    const rest = buildEventsUpTo(day, DAY_END_MS, watermarks);
    const combinedIds = [...partial, ...rest].map((e) => e.id).sort();
    expect(combinedIds).toEqual(all.map((e) => e.id).sort());
    // No aggregate ever regresses below its watermark.
    for (const event of rest) {
      expect(event.sequence).toBeGreaterThan(watermarks.get(event.aggregateId) ?? 0);
    }
  });

  it("orders events by scenario time (replay order == append order)", () => {
    const day = buildReferenceDay();
    const events = buildEventsUpTo(day, DAY_END_MS);
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];
      if (!prev || !curr) throw new Error("unexpected sparse event list");
      expect(Date.parse(prev.occurredAt)).toBeLessThanOrEqual(Date.parse(curr.occurredAt));
    }
  });

  it("produces contract-valid envelopes + payloads (typed event parse)", () => {
    const day = buildReferenceDay();
    const events = buildEventsUpTo(day, Date.parse("2026-09-22T07:00:00Z"));
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(() => parseTypedEvent(event.type, event)).not.toThrow();
    }
  });

  it("hashes the empty log stably (reset semantics)", () => {
    expect(emptyLogHash()).toBe(eventLogHash([]));
    expect(emptyLogHash()).toMatch(/^[0-9a-f]{64}$/);
  });
});
