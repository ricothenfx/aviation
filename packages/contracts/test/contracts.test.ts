import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ERROR_CODES,
  ERROR_STATUS,
  ApiError,
  boardSnapshotSchema,
  cursorPageSchema,
  domainEventSchema,
  errorEnvelopeSchema,
  eventTypeSchema,
  loginRequestSchema,
  parseTypedEvent,
  taskStateSchema,
  wsFrameSchema,
} from "../src";

describe("error envelope (api-contracts.md §2)", () => {
  it("parses the documented example", () => {
    const example = {
      error: {
        code: "REPLAN_INFEASIBLE",
        message: "2 constraints unresolvable: fueling window, gate curfew",
        details: { taskId: ["fueling-window", "gate-curfew"] },
        requestId: "req_01JEXAMPLE",
      },
    };
    expect(errorEnvelopeSchema.safeParse(example).success).toBe(true);
  });

  it("maps every code to the documented HTTP status", () => {
    expect(ERROR_CODES).toHaveLength(8);
    expect(ERROR_STATUS.VALIDATION_ERROR).toBe(400);
    expect(ERROR_STATUS.UNAUTHENTICATED).toBe(401);
    expect(ERROR_STATUS.FORBIDDEN).toBe(403);
    expect(ERROR_STATUS.NOT_FOUND).toBe(404);
    expect(ERROR_STATUS.IDEMPOTENCY_CONFLICT).toBe(409);
    expect(ERROR_STATUS.REPLAN_INFEASIBLE).toBe(422);
    expect(ERROR_STATUS.RATE_LIMITED).toBe(429);
    expect(ERROR_STATUS.INTERNAL).toBe(500);
  });

  it("exposes status via ApiError", () => {
    const err = new ApiError("UNAUTHENTICATED", "missing session");
    expect(err.status).toBe(401);
  });
});

describe("event envelope (engineering-standards.md §4, ADR-0001)", () => {
  const base = {
    id: "evt_01JEXAMPLE",
    occurredAt: "2026-09-22T08:14:03+08:00",
    aggregateId: "0d5c1e59-cc2d-4cfe-b7c9-3573c3ef1a2e",
    aggregateType: "flight",
    sequence: 7,
  };

  it("parses a valid domain event", () => {
    expect(
      domainEventSchema.safeParse({ ...base, type: "turn.started", payload: {} }).success,
    ).toBe(true);
  });

  it("rejects unknown event types (no in-place vocabulary growth)", () => {
    const result = domainEventSchema.safeParse({ ...base, type: "turn.restart", payload: {} });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive sequence and non-uuid aggregates", () => {
    expect(
      domainEventSchema.safeParse({ ...base, type: "turn.started", sequence: 0, payload: {} })
        .success,
    ).toBe(false);
    expect(
      domainEventSchema.safeParse({
        ...base,
        aggregateId: "not-a-uuid",
        type: "turn.started",
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("constrains the vocabulary to the documented types", () => {
    expect(eventTypeSchema.options).toContain("task.state_changed");
    expect(eventTypeSchema.options).toContain("alert.acknowledged");
    expect(eventTypeSchema.options).toContain("scenario.tick");
  });
});

describe("typed event payloads (api-contracts.md §3)", () => {
  it("validates a task.state_changed event end to end", () => {
    const raw = {
      id: "evt_02JEXAMPLE",
      type: "task.state_changed",
      occurredAt: "2026-09-22T08:15:00+08:00",
      aggregateId: "7b3a1f29-1c5e-4a3f-9d2e-6f0f21fdba31",
      aggregateType: "task",
      sequence: 12,
      payload: {
        flightId: "0d5c1e59-cc2d-4cfe-b7c9-3573c3ef1a2e",
        taskId: "7b3a1f29-1c5e-4a3f-9d2e-6f0f21fdba31",
        state: "in_progress",
        scenarioTs: "2026-09-22T08:15:00+08:00",
        slaRemainingMin: 18,
      },
    };
    const parsed = parseTypedEvent("task.state_changed", raw);
    expect(parsed.payload.state).toBe("in_progress");
    expect(parsed.payload.slaRemainingMin).toBe(18);
  });

  it("rejects a task.state_changed payload with an undocumented state", () => {
    const raw = {
      id: "evt_03JEXAMPLE",
      type: "task.state_changed",
      occurredAt: "2026-09-22T08:15:00+08:00",
      aggregateId: "7b3a1f29-1c5e-4a3f-9d2e-6f0f21fdba31",
      aggregateType: "task",
      sequence: 13,
      payload: {
        flightId: "0d5c1e59-cc2d-4cfe-b7c9-3573c3ef1a2e",
        taskId: "7b3a1f29-1c5e-4a3f-9d2e-6f0f21fdba31",
        state: "cancelled",
        scenarioTs: "2026-09-22T08:15:00+08:00",
        slaRemainingMin: 18,
      },
    };
    expect(taskStateSchema.safeParse("cancelled").success).toBe(false);
    expect(() => parseTypedEvent("task.state_changed", raw)).toThrow();
  });

  it("validates a ws frame with lastEventId (api-contracts.md §3)", () => {
    const frame = {
      id: "f_01",
      ts: "2026-09-22T08:15:01+08:00",
      channel: "board",
      type: "kpi.updated",
      payload: { onTimeDepPct: 82.5, avgTurnMin: 41, activeAlerts: 2, delayMinutesSaved: 12 },
      lastEventId: "evt_02JEXAMPLE",
    };
    expect(wsFrameSchema.safeParse(frame).success).toBe(true);
    expect(wsFrameSchema.safeParse({ ...frame, lastEventId: null }).success).toBe(true);
  });
});

describe("api schemas (api-contracts.md §1)", () => {
  it("validates login request/response shapes", () => {
    expect(
      loginRequestSchema.safeParse({ email: "maya.tan@nx-sim.example", password: "x" }).success,
    ).toBe(true);
    expect(loginRequestSchema.safeParse({ email: "not-an-email", password: "x" }).success).toBe(
      false,
    );
  });

  it("validates the F1 board snapshot (empty flights, nullable kpis)", () => {
    const snapshot = {
      generatedAt: "2026-09-22T02:00:00Z",
      scenarioTs: null,
      live: false,
      flights: [],
      kpis: null,
    };
    expect(boardSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("supports cursor pagination over event items", () => {
    const page = cursorPageSchema(z.string().min(1));
    const parsed = page.safeParse({ items: ["a", "b"], nextCursor: "c" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.nextCursor).toBe("c");
  });
});
