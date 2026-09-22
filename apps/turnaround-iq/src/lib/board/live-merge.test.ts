import { describe, expect, it } from "vitest";

import {
  boardSnapshotSchema,
  type BoardSnapshot,
  type FlightProjection,
  type WsFrame,
} from "@aviation/contracts";

import { mergeFrameIntoSnapshot, slaRemainingMin } from "./live-merge";

const FLIGHT_ID = "0d5c1e59-cc2d-4cfe-b7c9-3573c3ef1a2e";
const TASK_ID = "7b3a1f29-1c5e-4a3f-9d2e-6f0f21fdba31";

function snapshotWith(flight: FlightProjection): BoardSnapshot {
  return boardSnapshotSchema.parse({
    generatedAt: "2026-09-22T06:00:00Z",
    scenarioTs: "2026-09-22T06:00:00Z",
    live: true,
    flights: [flight],
    kpis: null,
  });
}

function plannedFlight(overrides: Partial<FlightProjection> = {}): FlightProjection {
  return {
    id: FLIGHT_ID,
    flightNo: "NX-101",
    standId: FLIGHT_ID,
    standCode: "A1",
    aircraftTypeCode: "NB320",
    schedInBlock: "2026-09-22T06:00:00Z",
    schedOffBlock: "2026-09-22T06:48:00Z",
    estOffBlock: "2026-09-22T06:48:00Z",
    status: "scheduled",
    delayedMin: 0,
    tasks: [
      {
        id: TASK_ID,
        flightId: FLIGHT_ID,
        type: "alighting",
        state: "pending",
        slaMinutes: 12,
        plannedStart: "2026-09-22T06:00:00Z",
        plannedEnd: "2026-09-22T06:12:00Z",
      },
      {
        id: "8b3a1f29-1c5e-4a3f-9d2e-6f0f21fdba31",
        flightId: FLIGHT_ID,
        type: "pushback",
        state: "pending",
        slaMinutes: 6,
        plannedStart: "2026-09-22T06:42:00Z",
        plannedEnd: "2026-09-22T06:48:00Z",
      },
    ],
    ...overrides,
  };
}

function frame(type: WsFrame["type"], payload: unknown, lastEventId = "evt:x"): WsFrame {
  return { id: "f:1", ts: "2026-09-22T06:00:01Z", channel: "board", type, payload, lastEventId };
}

describe("live frame merge (api-contracts.md §3 client path)", () => {
  it("scenario.tick updates the scenario clock and flags live", () => {
    const snapshot = snapshotWith(plannedFlight());
    const merged = mergeFrameIntoSnapshot(
      snapshot,
      frame("scenario.tick", { scenarioTs: "2026-09-22T06:05:00Z", speed: 5 }),
    );
    expect(merged.scenarioTs).toBe("2026-09-22T06:05:00Z");
    expect(merged.live).toBe(true);
  });

  it("task.state_changed walks statuses and marks off_block at pushback done", () => {
    const snapshot = snapshotWith(plannedFlight());
    const inProgress = mergeFrameIntoSnapshot(
      snapshot,
      frame("turn.started", {
        flightId: FLIGHT_ID,
        standCode: "A1",
        scenarioTs: "2026-09-22T06:00:00Z",
      }),
    );
    const turning = mergeFrameIntoSnapshot(
      inProgress,
      frame("task.state_changed", {
        flightId: FLIGHT_ID,
        taskId: TASK_ID,
        state: "in_progress",
        scenarioTs: "2026-09-22T06:00:30Z",
        slaRemainingMin: 12,
      }),
    );
    expect(turning.flights[0]?.status).toBe("turnaround");

    const done = mergeFrameIntoSnapshot(
      turning,
      frame("task.state_changed", {
        flightId: FLIGHT_ID,
        taskId: "8b3a1f29-1c5e-4a3f-9d2e-6f0f21fdba31",
        state: "done",
        scenarioTs: "2026-09-22T06:50:00Z",
        slaRemainingMin: 0,
      }),
    );
    expect(done.flights[0]?.status).toBe("off_block");
    expect(done.flights[0]?.estOffBlock).toBe("2026-09-22T06:50:00Z");
    expect(done.flights[0]?.delayedMin).toBe(2);
  });

  it("flight.delay_risk updates the projection and delayed status", () => {
    const snapshot = snapshotWith(plannedFlight());
    const merged = mergeFrameIntoSnapshot(
      snapshot,
      frame("flight.delay_risk", {
        flightId: FLIGHT_ID,
        projectedOffBlock: "2026-09-22T07:03:00Z",
        delayMin: 15,
        causeTaskId: TASK_ID,
      }),
    );
    expect(merged.flights[0]?.status).toBe("delayed");
    expect(merged.flights[0]?.delayedMin).toBe(15);
  });

  it("is idempotent for duplicate frames", () => {
    const snapshot = snapshotWith(plannedFlight());
    const f = frame("task.state_changed", {
      flightId: FLIGHT_ID,
      taskId: TASK_ID,
      state: "in_progress",
      scenarioTs: "2026-09-22T06:00:30Z",
      slaRemainingMin: 12,
    });
    const once = mergeFrameIntoSnapshot(mergeFrameIntoSnapshot(snapshot, f), f);
    const twice = mergeFrameIntoSnapshot(
      mergeFrameIntoSnapshot(mergeFrameIntoSnapshot(snapshot, f), f),
      f,
    );
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("ignores frames for unknown flights instead of throwing", () => {
    const snapshot = snapshotWith(plannedFlight());
    const merged = mergeFrameIntoSnapshot(
      snapshot,
      frame("task.state_changed", {
        flightId: "9b3a1f29-1c5e-4a3f-9d2e-6f0f21fdba31",
        taskId: TASK_ID,
        state: "done",
        scenarioTs: "2026-09-22T06:00:30Z",
        slaRemainingMin: 0,
      }),
    );
    expect(merged).toBe(snapshot);
  });

  it("computes an honest SLA countdown against scenario time", () => {
    const task = plannedFlight().tasks[0];
    if (!task) throw new Error("fixture missing task");
    expect(slaRemainingMin(task, "2026-09-22T06:00:00Z")).toBe(12);
    expect(slaRemainingMin(task, "2026-09-22T06:20:00Z")).toBe(0);
    expect(slaRemainingMin(task, null)).toBeNull();
  });
});
