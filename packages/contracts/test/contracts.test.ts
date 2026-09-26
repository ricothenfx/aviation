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
  EVENT_TYPES,
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
    // 8 original codes + OFFER_EXPIRED/SAGA_CONFLICT/PROPOSAL_NOT_PENDING joined
    // additively from rebook-ai (api-contracts.md §2, D-11/D-14 precedent).
    expect(ERROR_CODES).toHaveLength(11);
    expect(ERROR_STATUS.VALIDATION_ERROR).toBe(400);
    expect(ERROR_STATUS.UNAUTHENTICATED).toBe(401);
    expect(ERROR_STATUS.FORBIDDEN).toBe(403);
    expect(ERROR_STATUS.NOT_FOUND).toBe(404);
    expect(ERROR_STATUS.IDEMPOTENCY_CONFLICT).toBe(409);
    expect(ERROR_STATUS.REPLAN_INFEASIBLE).toBe(422);
    expect(ERROR_STATUS.RATE_LIMITED).toBe(429);
    expect(ERROR_STATUS.INTERNAL).toBe(500);
    expect(ERROR_STATUS.OFFER_EXPIRED).toBe(409);
    expect(ERROR_STATUS.SAGA_CONFLICT).toBe(409);
    expect(ERROR_STATUS.PROPOSAL_NOT_PENDING).toBe(409);
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

describe("rebook-ai event contracts (rebook-ai api-contracts.md §2, F1 DoD)", () => {
  const REBOOK_TYPES = [
    "flight.disrupted",
    "offer.created",
    "offer.expired",
    "offer.confirmed",
    "saga.step.completed",
    "saga.failed",
    "saga.compensated",
    "booking.issued",
    "voucher.issued",
    "notification.sent",
    "proposal.created",
    "proposal.approved",
    "proposal.rejected",
  ] as const;

  const uuidA = "0d5c1e59-cc2d-4cfe-b7c9-3573c3ef1a2e";
  const uuidB = "7b3a1f29-1c5e-4a3f-9d2e-6f0f21fdba31";
  const ts = "2026-09-26T08:14:03+08:00";

  /** Envelope factory per rebook aggregate; payload filled per case below. */
  function envelope(
    aggregateType: string,
    aggregateId: string,
    sequence: number,
    type: string,
    payload: unknown,
  ) {
    return {
      id: `evt_rb_${sequence}`,
      type,
      occurredAt: ts,
      aggregateId,
      aggregateType,
      sequence,
      payload,
    };
  }

  it("keeps the vocabulary additive: every rebook type registered, originals untouched", () => {
    for (const t of REBOOK_TYPES) expect(EVENT_TYPES).toContain(t);
    expect(eventTypeSchema.options).toContain("turn.started");
    expect(eventTypeSchema.options).toContain("replan.proposed");
  });

  it("validates flight.disrupted end to end", () => {
    const parsed = parseTypedEvent(
      "flight.disrupted",
      envelope("flight", uuidA, 1, "flight.disrupted", {
        flightNo: "NX 288",
        disruptionKind: "cancellation",
        delayMinutes: 0,
        reasonCode: "CREW_OUT",
        affectedPnrs: 42,
      }),
    );
    expect(parsed.payload.disruptionKind).toBe("cancellation");
    expect(parsed.aggregateType).toBe("flight");
  });

  it("validates offer.created / offer.confirmed with ranked options and role", () => {
    const created = parseTypedEvent(
      "offer.created",
      envelope("pnr", uuidA, 2, "offer.created", {
        pnrId: uuidA,
        offerId: uuidB,
        optionCount: 3,
        voucherIssued: true,
      }),
    );
    expect(created.payload.optionCount).toBe(3);
    const confirmed = parseTypedEvent(
      "offer.confirmed",
      envelope("offer", uuidB, 3, "offer.confirmed", {
        offerId: uuidB,
        optionId: uuidA,
        byRole: "passenger",
        sagaId: null,
      }),
    );
    expect(confirmed.payload.byRole).toBe("passenger");
    // Undocumented roles are rejected — no in-place vocabulary growth.
    expect(() =>
      parseTypedEvent("offer.confirmed", {
        ...envelope("offer", uuidB, 4, "offer.confirmed", {
          offerId: uuidB,
          optionId: uuidA,
          byRole: "crew",
          sagaId: null,
        }),
      }),
    ).toThrow();
  });

  it("validates the saga lifecycle payloads", () => {
    const step = parseTypedEvent(
      "saga.step.completed",
      envelope("saga", uuidA, 5, "saga.step.completed", {
        sagaId: uuidA,
        step: "seat_reserve",
        latencyMs: 40,
      }),
    );
    expect(step.payload.step).toBe("seat_reserve");
    const failed = parseTypedEvent(
      "saga.failed",
      envelope("saga", uuidA, 6, "saga.failed", {
        sagaId: uuidA,
        step: "payment",
        errorCode: "PSP_DECLINED",
      }),
    );
    expect(failed.payload.errorCode).toBe("PSP_DECLINED");
    const compensated = parseTypedEvent(
      "saga.compensated",
      envelope("saga", uuidA, 7, "saga.compensated", {
        sagaId: uuidA,
        compensatedSteps: ["payment", "seat_reserve"],
      }),
    );
    expect(compensated.payload.compensatedSteps).toHaveLength(2);
  });

  it("validates booking.issued, voucher.issued and notification.sent", () => {
    expect(
      parseTypedEvent(
        "booking.issued",
        envelope("pnr", uuidA, 8, "booking.issued", {
          sagaId: uuidA,
          pnrId: uuidA,
          newFlightNo: "SV 1102",
          boardingPassRef: "BP-NXQ4ZK-1",
        }),
      ).payload.boardingPassRef,
    ).toBe("BP-NXQ4ZK-1");
    expect(
      parseTypedEvent(
        "voucher.issued",
        envelope("voucher", uuidB, 9, "voucher.issued", {
          voucherId: uuidB,
          pnrId: uuidA,
          criteria: { rule: "cancellation_meal", met: true, delayMinutes: 0 },
        }),
      ).payload.criteria,
    ).toHaveProperty("rule");
    expect(
      parseTypedEvent(
        "notification.sent",
        envelope("notification", uuidB, 10, "notification.sent", {
          notificationId: uuidB,
          pnrId: uuidA,
          channel: "inbox",
        }),
      ).payload.channel,
    ).toBe("inbox");
  });

  it("validates the propose-only proposal lifecycle (D-10 source badges)", () => {
    const created = parseTypedEvent(
      "proposal.created",
      envelope("proposal", uuidB, 11, "proposal.created", {
        proposalId: uuidB,
        pnrId: uuidA,
        source: "llm",
        provider: "mock",
      }),
    );
    expect(created.payload).toMatchObject({ source: "llm", provider: "mock" });
    expect(
      parseTypedEvent(
        "proposal.approved",
        envelope("proposal", uuidB, 12, "proposal.approved", {
          proposalId: uuidB,
          approverId: uuidA,
        }),
      ).payload.approverId,
    ).toBe(uuidA);
    expect(() =>
      parseTypedEvent(
        "proposal.rejected",
        envelope("proposal", uuidB, 13, "proposal.rejected", {
          proposalId: uuidB,
          approverId: uuidA,
        }),
      ),
    ).toThrow(); // reject requires a mandatory note
  });

  it("keeps envelope invariants for rebook aggregates (uuid aggregate, positive sequence)", () => {
    const bad = envelope("saga", "not-a-uuid", 0, "saga.failed", {
      sagaId: uuidA,
      step: "payment",
      errorCode: "X",
    });
    expect(domainEventSchema.safeParse(bad).success).toBe(false);
  });
});
