import { describe, expect, it } from "vitest";

import { wsFrameSchema, type WsFrame } from "@aviation/contracts";

import {
  buildEventFrame,
  buildKpiFrame,
  buildTickFrame,
  coalesceFrames,
  OutboundQueue,
  framesForEvent,
} from "./frames";

const TS = "2026-09-22T06:00:00Z";

function taskEvent(sequence: number, state: "in_progress" | "done") {
  return {
    id: `evt:task:7b3a1f29-1c5e-4a3f-9d2e-6f0f21fdba31:${sequence}`,
    type: "task.state_changed" as const,
    occurredAt: TS,
    aggregateId: "7b3a1f29-1c5e-4a3f-9d2e-6f0f21fdba31",
    aggregateType: "task" as const,
    sequence,
    payload: {
      flightId: "0d5c1e59-cc2d-4cfe-b7c9-3573c3ef1a2e",
      taskId: "7b3a1f29-1c5e-4a3f-9d2e-6f0f21fdba31",
      state,
      scenarioTs: TS,
      slaRemainingMin: 12,
    },
  };
}

describe("ws frames (api-contracts.md §3)", () => {
  it("event frames validate against the wsFrameSchema contract", () => {
    const frames = framesForEvent(taskEvent(1, "in_progress"), TS);
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(wsFrameSchema.safeParse(frame).success).toBe(true);
    }
    const [boardFrame, flightFrame] = frames;
    expect(boardFrame?.channel).toBe("board");
    expect(flightFrame?.channel).toBe("flight:0d5c1e59-cc2d-4cfe-b7c9-3573c3ef1a2e");
  });

  it("kpi + tick frames are board-channel and contract-valid", () => {
    const kpiFrame = buildKpiFrame(
      { onTimeDepPct: 80, avgTurnMin: 48, activeAlerts: 0, delayMinutesSaved: 0 },
      null,
      TS,
    );
    const tickFrame = buildTickFrame("2026-09-22T06:00:05Z", 5, TS);
    expect(kpiFrame.channel).toBe("board");
    expect(tickFrame.channel).toBe("board");
    expect(wsFrameSchema.safeParse(kpiFrame).success).toBe(true);
    expect(wsFrameSchema.safeParse(tickFrame).success).toBe(true);
  });
});

describe("coalescing (architecture.md §6)", () => {
  it("keeps every event-history frame", () => {
    const pending: WsFrame[] = [
      buildEventFrame(taskEvent(1, "in_progress"), "board", TS),
      buildEventFrame(taskEvent(2, "done"), "board", TS),
    ];
    expect(coalesceFrames(pending)).toHaveLength(2);
  });

  it("collapses superseded kpi/tick frames to the newest per channel", () => {
    const pending: WsFrame[] = [
      buildTickFrame("2026-09-22T06:00:01Z", 5, TS),
      buildKpiFrame(
        { onTimeDepPct: 10, avgTurnMin: 1, activeAlerts: 0, delayMinutesSaved: 0 },
        null,
        TS,
      ),
      buildTickFrame("2026-09-22T06:00:02Z", 5, TS),
      buildKpiFrame(
        { onTimeDepPct: 20, avgTurnMin: 2, activeAlerts: 0, delayMinutesSaved: 0 },
        null,
        TS,
      ),
      buildEventFrame(taskEvent(1, "in_progress"), "board", TS),
    ];
    const coalesced = coalesceFrames(pending);
    expect(coalesced).toHaveLength(3);
    const ticks = coalesced.filter((f) => f.type === "scenario.tick");
    expect(ticks).toHaveLength(1);
    expect((ticks[0]?.payload as { scenarioTs: string }).scenarioTs).toBe("2026-09-22T06:00:02Z");
  });
});

describe("outbound queue (backpressure per architecture.md §6)", () => {
  it("drops the oldest frames beyond capacity, keeping recent ones", () => {
    const queue = new OutboundQueue(3, 10);
    for (let i = 1; i <= 5; i++)
      queue.push(buildEventFrame(taskEvent(i, "in_progress"), "board", TS));
    const batch = queue.flush();
    expect(batch).toHaveLength(3);
    expect(batch[0]?.lastEventId).toContain(":3");
    expect(batch[2]?.lastEventId).toContain(":5");
    expect(queue.size()).toBe(0);
  });

  it("respects maxFramesPerFlush and keeps the remainder queued", () => {
    const queue = new OutboundQueue(100, 2);
    for (let i = 1; i <= 5; i++)
      queue.push(buildEventFrame(taskEvent(i, "in_progress"), "board", TS));
    const first = queue.flush();
    expect(first).toHaveLength(2);
    expect(queue.size()).toBe(3);
  });
});
