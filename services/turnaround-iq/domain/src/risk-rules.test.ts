import { describe, expect, it } from "vitest";

import { evaluateRiskRules, riskAlertKey, type RiskSnapshot } from "./risk-rules";

/**
 * Risk-rule unit tests (PRD F-3, api-contracts.md §4). The loader-breakdown
 * shape: baggage_load blocked with 49 min outage + 9 min remaining work ⇒ both
 * the task SLA rule and the departure rule must fire with lead ≥ 10 min.
 */

const T0 = Date.parse("2026-09-22T12:00:00Z");
const at = (offsetMin: number): string => new Date(T0 + offsetMin * 60_000).toISOString();

function snapshot(overrides: Partial<RiskSnapshot> = {}): RiskSnapshot {
  return {
    flightId: "11111111-1111-4111-8111-111111111111",
    flightNo: "NX-201",
    schedOffBlock: at(48),
    now: at(31),
    tasks: [
      {
        id: "alighting",
        type: "alighting",
        state: "done",
        plannedStart: at(0),
        plannedEnd: at(12),
        remainingMin: 0,
        blockedUntil: null,
      },
      {
        id: "baggage_load",
        type: "baggage_load",
        state: "blocked",
        plannedStart: at(26),
        plannedEnd: at(40),
        remainingMin: 9,
        blockedUntil: at(31 + 49),
      },
      {
        id: "boarding",
        type: "boarding",
        state: "in_progress",
        plannedStart: at(26),
        plannedEnd: at(42),
        remainingMin: 11,
        blockedUntil: null,
      },
      {
        id: "pushback",
        type: "pushback",
        state: "pending",
        plannedStart: at(42),
        plannedEnd: at(48),
        remainingMin: 6,
        blockedUntil: null,
      },
    ],
    dependencies: [
      { taskId: "pushback", predecessorTaskId: "boarding" },
      { taskId: "pushback", predecessorTaskId: "baggage_load" },
    ],
    ...overrides,
  };
}

describe("evaluateRiskRules", () => {
  it("flags a blocked load ≥ 10 min ahead of its projected SLA breach", () => {
    const findings = evaluateRiskRules(snapshot());
    const sla = findings.find((f) => f.ruleId === "sla.projected_breach");
    expect(sla).toBeDefined();
    expect(sla?.causeTaskId).toBe("baggage_load");
    // projected finish = now + (49 outage + 9 work) = inject + 58 ⇒ lead 58
    expect(sla?.leadTimeMin).toBe(58);
    expect(sla?.projectedBreachTs).toBe(at(31 + 58));
    expect(sla?.severity).toBe("warning");
  });

  it("raises a critical departure.at_risk with the blocking task as cause", () => {
    const findings = evaluateRiskRules(snapshot());
    const dep = findings.find((f) => f.ruleId === "departure.at_risk");
    expect(dep).toBeDefined();
    expect(dep?.severity).toBe("critical");
    expect(dep?.causeTaskId).toBe("baggage_load");
    // pushback waits for the load: 31+58 → +6 ⇒ projected off-block = +64, delay 16
    expect(dep?.projectedBreachTs).toBe(at(31 + 64));
    expect(dep?.leadTimeMin).toBe(64);
  });

  it("stays silent when everything is on plan", () => {
    const quiet = snapshot({
      tasks: [
        {
          id: "baggage_load",
          type: "baggage_load",
          state: "in_progress",
          plannedStart: at(26),
          plannedEnd: at(40),
          remainingMin: 9,
          blockedUntil: null,
        },
        {
          id: "boarding",
          type: "boarding",
          state: "in_progress",
          plannedStart: at(26),
          plannedEnd: at(42),
          remainingMin: 11,
          blockedUntil: null,
        },
        {
          id: "pushback",
          type: "pushback",
          state: "pending",
          plannedStart: at(42),
          plannedEnd: at(48),
          remainingMin: 6,
          blockedUntil: null,
        },
      ],
    });
    expect(evaluateRiskRules(quiet)).toEqual([]);
  });

  it("never cries wolf on a PLANNED-delayed flight running to plan (seed slips)", () => {
    // Seed flights with delayedMin > 0 carry the slip inside their planned
    // windows (pushback plannedEnd 61 vs schedOffBlock 48). Running to plan is
    // not a risk — only slipping PAST the plan alerts (PRD F-3).
    const plannedLate = snapshot({
      schedOffBlock: at(48),
      tasks: [
        {
          id: "baggage_load",
          type: "baggage_load",
          state: "in_progress",
          plannedStart: at(26),
          plannedEnd: at(53),
          remainingMin: 22,
          blockedUntil: null,
        },
        {
          id: "boarding",
          type: "boarding",
          state: "in_progress",
          plannedStart: at(26),
          plannedEnd: at(55),
          remainingMin: 24,
          blockedUntil: null,
        },
        {
          id: "pushback",
          type: "pushback",
          state: "pending",
          plannedStart: at(55),
          plannedEnd: at(61),
          remainingMin: 6,
          blockedUntil: null,
        },
      ],
      dependencies: [
        { taskId: "pushback", predecessorTaskId: "boarding" },
        { taskId: "pushback", predecessorTaskId: "baggage_load" },
      ],
    });
    expect(evaluateRiskRules(plannedLate)).toEqual([]);
  });

  it("suppresses findings whose lead time is under the 10-minute PRD floor", () => {
    // Task ends at +36, blocked until +31 with 6 min work ⇒ breach at +37:
    // real, but only 6 min ahead — under the floor, so no alert (PRD F-3).
    const late = snapshot({
      tasks: [
        {
          id: "baggage_load",
          type: "baggage_load",
          state: "blocked",
          plannedStart: at(26),
          plannedEnd: at(36),
          remainingMin: 6,
          blockedUntil: at(31),
        },
        {
          id: "pushback",
          type: "pushback",
          state: "pending",
          plannedStart: at(42),
          plannedEnd: at(48),
          remainingMin: 6,
          blockedUntil: null,
        },
      ],
      dependencies: [{ taskId: "pushback", predecessorTaskId: "baggage_load" }],
    });
    const findings = evaluateRiskRules(late);
    expect(findings.find((f) => f.causeTaskId === "baggage_load")).toBeUndefined();
  });

  it("never re-flags already finished work", () => {
    const findings = evaluateRiskRules(
      snapshot({
        tasks: [
          {
            id: "baggage_load",
            type: "baggage_load",
            state: "done",
            plannedStart: at(26),
            plannedEnd: at(40),
            remainingMin: 0,
            blockedUntil: null,
          },
          {
            id: "pushback",
            type: "pushback",
            state: "pending",
            plannedStart: at(42),
            plannedEnd: at(48),
            remainingMin: 6,
            blockedUntil: null,
          },
        ],
        dependencies: [{ taskId: "pushback", predecessorTaskId: "baggage_load" }],
      }),
    );
    expect(findings).toEqual([]);
  });

  it("builds stable dedup keys per (rule, cause task)", () => {
    expect(riskAlertKey({ ruleId: "sla.projected_breach", causeTaskId: "t1" })).toBe(
      "sla.projected_breach:t1",
    );
  });
});
