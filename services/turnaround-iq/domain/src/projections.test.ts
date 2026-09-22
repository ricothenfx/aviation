import { describe, expect, it } from "vitest";

import {
  applyEvent,
  applyRawEvent,
  deriveKpis,
  emptyProjectionState,
  initialStateFromReferenceDay,
  toBoardSnapshot,
} from "./projections";
import { buildEventsUpTo, buildReferenceDay } from "./index";

function makeTurnStarted(flightId: string, scenarioTs: string) {
  return {
    id: `evt:flight:${flightId}:1`,
    type: "turn.started" as const,
    occurredAt: scenarioTs,
    aggregateId: flightId,
    aggregateType: "flight" as const,
    sequence: 1,
    payload: { flightId, standCode: "A1", scenarioTs },
  };
}

function makeTaskEvent(args: {
  taskId: string;
  flightId: string;
  state: "in_progress" | "done";
  scenarioTs: string;
  slaRemainingMin: number;
}) {
  return {
    id: `evt:task:${args.taskId}:${args.state === "in_progress" ? 1 : 2}`,
    type: "task.state_changed" as const,
    occurredAt: args.scenarioTs,
    aggregateId: args.taskId,
    aggregateType: "task" as const,
    sequence: args.state === "in_progress" ? 1 : 2,
    payload: {
      flightId: args.flightId,
      taskId: args.taskId,
      state: args.state,
      scenarioTs: args.scenarioTs,
      slaRemainingMin: args.slaRemainingMin,
    },
  };
}

describe("projections (ADR-0001 apply logic)", () => {
  it("baseline marks scheduled flights and propagates the planned slip", () => {
    const day = buildReferenceDay();
    const state = initialStateFromReferenceDay(day);
    expect(state.flights.size).toBe(60);
    const delayed = [...state.flights.values()].filter((f) => f.status === "delayed");
    expect(delayed.length).toBe(day.flights.filter((f) => f.delayedMin > 0).length);
    for (const flight of state.flights.values()) {
      expect(flight.tasks.every((t) => t.state === "pending")).toBe(true);
    }
  });

  it("walks scheduled → in_block → turnaround → off_block from events", () => {
    const day = buildReferenceDay();
    const state = initialStateFromReferenceDay(day);
    const flight = [...state.flights.values()].find((f) => f.delayedMin === 0);
    if (!flight) throw new Error("fixture missing an on-time flight");
    const firstTask = flight.tasks[0];
    const pushback = flight.tasks.find((t) => t.type === "pushback");
    if (!firstTask || !pushback) throw new Error("fixture missing tasks");

    applyEvent(state, makeTurnStarted(flight.id, "2026-09-22T06:00:00Z"));
    expect(state.flights.get(flight.id)?.status).toBe("in_block");

    applyEvent(
      state,
      makeTaskEvent({
        taskId: firstTask.id,
        flightId: flight.id,
        state: "in_progress",
        scenarioTs: "2026-09-22T06:01:00Z",
        slaRemainingMin: 12,
      }),
    );
    expect(state.flights.get(flight.id)?.status).toBe("turnaround");

    applyEvent(
      state,
      makeTaskEvent({
        taskId: pushback.id,
        flightId: flight.id,
        state: "done",
        scenarioTs: "2026-09-22T06:48:00Z",
        slaRemainingMin: 0,
      }),
    );
    const done = state.flights.get(flight.id);
    expect(done?.status).toBe("off_block");
    expect(done?.estOffBlock).toBe("2026-09-22T06:48:00Z");
    expect(done?.delayedMin).toBe(0);
  });

  it("re-applying the same event is a no-op (idempotent projection)", () => {
    const day = buildReferenceDay();
    const state = initialStateFromReferenceDay(day);
    const flight = [...state.flights.values()][0];
    if (!flight) throw new Error("empty fixture");
    const task = flight.tasks[0];
    if (!task) throw new Error("flight missing tasks");
    const event = makeTaskEvent({
      taskId: task.id,
      flightId: flight.id,
      state: "in_progress",
      scenarioTs: "2026-09-22T06:01:00Z",
      slaRemainingMin: 12,
    });

    applyEvent(state, event);
    const once = JSON.stringify(toBoardSnapshot(state, { generatedAt: "x", live: true }));
    for (let i = 0; i < 5; i++) applyEvent(state, event);
    const fiveTimes = JSON.stringify(toBoardSnapshot(state, { generatedAt: "x", live: true }));
    expect(fiveTimes).toBe(once);
  });

  it("full-log replay converges to every flight off_block and tasks done", () => {
    const day = buildReferenceDay();
    const dayEndMs = Date.parse("2026-09-22T21:00:00Z");
    const events = buildEventsUpTo(day, dayEndMs);
    const state = initialStateFromReferenceDay(day);
    for (const event of events) applyRawEvent(state, event);

    expect(events.length).toBe(60 * (1 + 12 * 2));
    for (const flight of state.flights.values()) {
      expect(flight.status).toBe("off_block");
      expect(flight.tasks.every((t) => t.state === "done")).toBe(true);
      expect(flight.estOffBlock).not.toBeNull();
    }
    const kpis = deriveKpis(state);
    expect(kpis.onTimeDepPct).toBeGreaterThan(0);
    expect(kpis.onTimeDepPct).toBeLessThan(100);
    expect(kpis.avgTurnMin).toBeGreaterThan(40);
    expect(kpis.activeAlerts).toBe(0);
  });

  it("kpi.updated and scenario.tick frames update snapshot fields", () => {
    const state = emptyProjectionState();
    applyEvent(state, {
      id: "evt:x",
      type: "kpi.updated" as const,
      occurredAt: "2026-09-22T06:00:00Z",
      aggregateId: "0d5c1e59-cc2d-4cfe-b7c9-3573c3ef1a2e",
      aggregateType: "scenario" as const,
      sequence: 1,
      payload: { onTimeDepPct: 90, avgTurnMin: 48.2, activeAlerts: 0, delayMinutesSaved: 0 },
    });
    applyEvent(state, {
      id: "evt:y",
      type: "scenario.tick" as const,
      occurredAt: "2026-09-22T06:00:05Z",
      aggregateId: "0d5c1e59-cc2d-4cfe-b7c9-3573c3ef1a2e",
      aggregateType: "scenario" as const,
      sequence: 2,
      payload: { scenarioTs: "2026-09-22T06:00:05Z", speed: 5 as const },
    });
    const snapshot = toBoardSnapshot(state, { generatedAt: "2026-09-22T06:00:06Z", live: true });
    expect(snapshot.kpis?.onTimeDepPct).toBe(90);
    expect(snapshot.scenarioTs).toBe("2026-09-22T06:00:05Z");
  });
});
