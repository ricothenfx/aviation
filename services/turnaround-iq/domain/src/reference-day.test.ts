import { describe, expect, it } from "vitest";

import { buildReferenceDay, plannedOffBlockIso, TASK_TYPES } from "./reference-day";

describe("reference day generator (PRD F-5 determinism)", () => {
  it("produces byte-identical output for the same seed", () => {
    const a = buildReferenceDay();
    const b = buildReferenceDay();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("differs across seeds", () => {
    const a = buildReferenceDay(42);
    const b = buildReferenceDay(43);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("matches the documented scenario scale (data-model.md §4)", () => {
    const day = buildReferenceDay();
    expect(day.flights).toHaveLength(60);
    for (const flight of day.flights) {
      expect(flight.tasks).toHaveLength(12);
    }
    expect(day.stands.length).toBeGreaterThanOrEqual(10);
  });

  it("uses the fictional NX brand only (data-ethics.md §2)", () => {
    const day = buildReferenceDay();
    for (const flight of day.flights) {
      expect(flight.flightNo).toMatch(/^NX-\d{3}$/);
    }
  });

  it("keeps ids stable and unique per entity kind", () => {
    const day = buildReferenceDay();
    const flightIds = day.flights.map((f) => f.id);
    expect(new Set(flightIds).size).toBe(flightIds.length);
    const taskIds = day.flights.flatMap((f) => f.tasks.map((t) => t.id));
    expect(new Set(taskIds).size).toBe(taskIds.length);
    expect(day.stands.map((s) => s.id)).toEqual(buildReferenceDay().stands.map((s) => s.id));
  });

  it("never assigns a stand to two overlapping turns", () => {
    const day = buildReferenceDay();
    const byStand = new Map<string, { inBlock: number; offBlock: number }[]>();
    for (const flight of day.flights) {
      const list = byStand.get(flight.standId) ?? [];
      list.push({
        inBlock: Date.parse(flight.schedInBlock),
        offBlock: Date.parse(plannedOffBlockIso(flight)),
      });
      byStand.set(flight.standId, list);
    }
    for (const windows of byStand.values()) {
      windows.sort((a, b) => a.inBlock - b.inBlock);
      for (let i = 1; i < windows.length; i++) {
        const prev = windows[i - 1];
        const curr = windows[i];
        if (!prev || !curr) throw new Error("unexpected sparse stand windows");
        expect(curr.inBlock).toBeGreaterThanOrEqual(prev.offBlock);
      }
    }
  });

  it("includes deterministic delays so the board shows late departures", () => {
    const day = buildReferenceDay();
    const delayed = day.flights.filter((f) => f.delayedMin > 0);
    expect(delayed.length).toBeGreaterThan(0);
    expect(delayed.length).toBeLessThan(day.flights.length);
    for (const flight of delayed) {
      expect(TASK_TYPES).toContain(flight.causeTaskType as (typeof TASK_TYPES)[number]);
      const pushback = flight.tasks.find((t) => t.type === "pushback");
      expect(pushback).toBeDefined();
      expect(Date.parse(pushback?.plannedEnd ?? "")).toBeGreaterThan(
        Date.parse(flight.schedOffBlock),
      );
    }
  });
});
