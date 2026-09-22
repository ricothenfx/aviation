import { describe, expect, it } from "vitest";

import {
  buildReferenceDay,
  DAY_START_ISO,
  initialScenarioState,
  type ScenarioClockState,
} from "@aviation/tiq-domain";

import { computeTick } from "./engine";

const DAY_START_MS = Date.parse(DAY_START_ISO);

function runningState(
  wallMs: number,
  overrides: Partial<ScenarioClockState> = {},
): ScenarioClockState {
  return {
    ...initialScenarioState("reference-day"),
    status: "running",
    speed: 1,
    scenarioNow: DAY_START_ISO,
    lastWallMs: wallMs,
    ...overrides,
  };
}

describe("scenario engine tick computation (architecture.md §3)", () => {
  it("emits nothing before the clock starts", () => {
    const day = buildReferenceDay();
    const idle = initialScenarioState("reference-day");
    const result = computeTick(day, idle, DAY_START_MS, new Map());
    expect(result.events).toHaveLength(0);
    expect(result.state.status).toBe("idle");
  });

  it("advances scenario time by elapsed wall time × speed", () => {
    const day = buildReferenceDay();
    const wall = DAY_START_MS;
    const state = runningState(wall);
    // 1 wall minute at speed 1 → 1 scenario minute.
    const result = computeTick(day, state, wall + 60_000, new Map());
    expect(result.state.scenarioNow).toBe("2026-09-22T05:01:00.000Z");
    expect(result.state.lastWallMs).toBe(wall + 60_000);
  });

  it("emits the first in-block events once the first flight is reached", () => {
    const day = buildReferenceDay();
    // First bank starts at 06:00Z = 60 min after day start.
    const horizon = Date.parse("2026-09-22T06:02:00Z");
    // Clock is consistent: scenarioNow and lastWallMs both at the horizon.
    const state = runningState(horizon, { scenarioNow: new Date(horizon).toISOString() });
    const result = computeTick(day, state, horizon, new Map());
    expect(result.events.length).toBeGreaterThan(0);
    for (const event of result.events) {
      expect(Date.parse(event.occurredAt)).toBeLessThanOrEqual(horizon);
    }
    const first = result.events[0];
    if (!first) throw new Error("expected events");
    expect(first.type).toBe("turn.started");
  });

  it("respects watermarks: already-emitted events never reappear", () => {
    const day = buildReferenceDay();
    const horizon = Date.parse("2026-09-22T07:00:00Z");
    const state = runningState(horizon, { scenarioNow: new Date(horizon).toISOString() });
    const firstPass = computeTick(day, state, horizon, new Map());
    const watermarks = new Map<string, number>();
    for (const event of firstPass.events) {
      watermarks.set(
        event.aggregateId,
        Math.max(watermarks.get(event.aggregateId) ?? 0, event.sequence),
      );
    }
    const secondPass = computeTick(day, state, horizon, watermarks);
    expect(secondPass.events).toHaveLength(0);
  });

  it("speed 20 advances 20 scenario minutes per wall minute", () => {
    const day = buildReferenceDay();
    const wall = DAY_START_MS;
    const state = runningState(wall, { speed: 20 });
    const result = computeTick(day, state, wall + 60_000, new Map());
    expect(result.state.scenarioNow).toBe("2026-09-22T05:20:00.000Z");
  });

  it("clamps at day end and flags completion", () => {
    const day = buildReferenceDay();
    const nearEnd = Date.parse("2026-09-22T20:59:00Z");
    const state = runningState(nearEnd, { scenarioNow: "2026-09-22T20:59:00.000Z" });
    const result = computeTick(day, state, nearEnd + 10 * 60_000, new Map());
    expect(result.state.status).toBe("completed");
    expect(result.state.scenarioNow).toBe("2026-09-22T21:00:00.000Z");
  });
});
