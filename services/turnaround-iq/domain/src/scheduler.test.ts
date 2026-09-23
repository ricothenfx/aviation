import { describe, expect, it } from "vitest";

import { planHash, planTasks } from "./scheduler";
import {
  buildScheduleContext,
  type TaskRuntimeState,
  type TurnPlanInput,
} from "./scheduler-context";

/**
 * Constraint-scheduler unit tests (PRD F-4, api-contracts.md §4). The canonical
 * loader-breakdown turn (on-time flight, inject 5 min into baggage_load, 49 min
 * outage, 1 spare loader, 5 min swap):
 *   do-nothing  → baggage_load ends 40+49=89, pushback 89–95 ⇒ delay 47 min
 *   replanned   → spare loader +5 swap ends 45, pushback 45–51 ⇒ delay 3 min
 */

const T0 = Date.parse("2026-09-22T14:00:00Z");
const at = (offsetMin: number): string => new Date(T0 + offsetMin * 60_000).toISOString();

const planned = [
  { id: "alighting", type: "alighting", plannedStart: at(0), plannedEnd: at(12) },
  { id: "baggage_unload", type: "baggage_unload", plannedStart: at(12), plannedEnd: at(26) },
  { id: "cleaning", type: "cleaning", plannedStart: at(12), plannedEnd: at(24) },
  { id: "catering", type: "catering", plannedStart: at(12), plannedEnd: at(26) },
  { id: "fueling", type: "fueling", plannedStart: at(14), plannedEnd: at(30) },
  { id: "baggage_load", type: "baggage_load", plannedStart: at(26), plannedEnd: at(40) },
  { id: "cabin_check", type: "cabin_check", plannedStart: at(24), plannedEnd: at(32) },
  { id: "document_check", type: "document_check", plannedStart: at(30), plannedEnd: at(38) },
  { id: "boarding", type: "boarding", plannedStart: at(26), plannedEnd: at(42) },
  { id: "pushback", type: "pushback", plannedStart: at(42), plannedEnd: at(48) },
];

const dependencies = [
  { taskId: "baggage_unload", predecessorTaskId: "alighting" },
  { taskId: "cleaning", predecessorTaskId: "alighting" },
  { taskId: "catering", predecessorTaskId: "alighting" },
  { taskId: "fueling", predecessorTaskId: "alighting" },
  { taskId: "baggage_load", predecessorTaskId: "baggage_unload" },
  { taskId: "cabin_check", predecessorTaskId: "cleaning" },
  { taskId: "boarding", predecessorTaskId: "cleaning" },
  { taskId: "boarding", predecessorTaskId: "catering" },
  { taskId: "pushback", predecessorTaskId: "boarding" },
  { taskId: "pushback", predecessorTaskId: "baggage_load" },
  { taskId: "pushback", predecessorTaskId: "fueling" },
];

/** Runtime states at inject (+5 into baggage_load, everything earlier done). */
function statesAtInject(): Map<string, TaskRuntimeState> {
  const states = new Map<string, TaskRuntimeState>();
  for (const task of planned) {
    if (Date.parse(task.plannedEnd) <= T0 + 31 * 60_000) {
      states.set(task.id, { state: "done", remainingMin: 0, blockedUntil: null });
    } else if (Date.parse(task.plannedStart) <= T0 + 31 * 60_000) {
      states.set(task.id, {
        state: "in_progress",
        remainingMin: Math.round((Date.parse(task.plannedEnd) - (T0 + 31 * 60_000)) / 60_000),
        blockedUntil: null,
      });
    }
  }
  states.set("baggage_load", { state: "blocked", remainingMin: 9, blockedUntil: at(31 + 49) });
  return states;
}

function loaderInput(): TurnPlanInput {
  return {
    flightId: "22222222-2222-4222-8222-222222222222",
    flightNo: "NX-204",
    schedOffBlock: at(48),
    planned,
    states: statesAtInject(),
    dependencies,
    now: at(31),
    unavailableUnits: [
      { unitId: "NX-204-baggage_loader", kind: "baggage_loader", availableAt: at(31 + 49) },
    ],
    spareUnits: { baggage_loader: 1 },
    standCurfew: null,
  };
}

describe("planTasks — loader breakdown", () => {
  it("measures the do-nothing cascade at exactly 47 minutes", () => {
    const plan = planTasks(buildScheduleContext(loaderInput()));
    expect(plan.feasible).toBe(true);
    expect(plan.baselineDelayMin).toBe(47);
    expect(plan.totalDelayMin).toBe(3);
  });

  it("reassigns the spare loader with swap overhead and keeps deps honest", () => {
    const plan = planTasks(buildScheduleContext(loaderInput()));
    const load = plan.assignments.find((a) => a.taskId === "baggage_load");
    expect(load?.reassigned).toBe(true);
    expect(load?.newStart).toBe(at(36)); // now + 5 min swap
    expect(load?.newEnd).toBe(at(45)); // 36 + 9 remaining work
    const pushback = plan.assignments.find((a) => a.taskId === "pushback");
    // waits for the reassigned load (45), not its planned start (42)
    expect(pushback?.newStart).toBe(at(45));
    expect(pushback?.newEnd).toBe(at(51));
  });

  it("produces a byte-identical plan hash for identical context (determinism)", () => {
    const first = planTasks(buildScheduleContext(loaderInput()));
    const second = planTasks(buildScheduleContext(loaderInput()));
    expect(planHash(first)).toBe(planHash(second));
    expect(first.rationale).toBe(second.rationale);
  });
});

describe("planTasks — crew no-show (infeasible)", () => {
  it("returns REPLAN_INFEASIBLE conflicts instead of violating constraints", () => {
    const states = statesAtInject();
    states.delete("baggage_load");
    states.set("cleaning", { state: "blocked", remainingMin: 12, blockedUntil: null });
    const input = loaderInput();
    const cleaning = planned.find((task) => task.id === "cleaning");
    const boarding = planned.find((task) => task.id === "boarding");
    expect(cleaning && boarding).toBeDefined();
    const plan = planTasks(
      buildScheduleContext({
        ...input,
        states,
        unavailableUnits: [
          { unitId: "NX-204-cleaning_crew", kind: "cleaning_crew", availableAt: null },
        ],
        spareUnits: { cleaning_crew: 0 },
      }),
    );
    expect(plan.feasible).toBe(false);
    expect(plan.totalDelayMin).toBe(-1);
    expect(plan.conflicts).toContain("unit_unavailable:cleaning_crew:cleaning");
    expect(plan.conflicts).toContain("dependency_unresolved:boarding:boarding");
    expect(plan.conflicts).toContain("dependency_unresolved:pushback:pushback");
  });
});

describe("planTasks — gate swap (stand curfew)", () => {
  it("flags a curfew breach when the plan cannot make the deadline", () => {
    // Deadline 8 min after now: pushback earliest finish is 51 (spare-swap path)
    // with the tug outage — provably past the curfew ⇒ conflict, not silence.
    const plan = planTasks(
      buildScheduleContext({
        ...loaderInput(),
        unavailableUnits: [
          { unitId: "NX-204-pushback_tug", kind: "pushback_tug", availableAt: at(31 + 20) },
        ],
        spareUnits: { pushback_tug: 1 },
        standCurfew: at(39),
      }),
    );
    expect(plan.conflicts.some((conflict) => conflict.startsWith("stand_curfew:"))).toBe(true);
    expect(plan.feasible).toBe(false);
  });

  it("respects the curfew with room to spare when the deadline is reachable", () => {
    const plan = planTasks(
      buildScheduleContext({
        ...loaderInput(),
        unavailableUnits: [
          { unitId: "NX-204-pushback_tug", kind: "pushback_tug", availableAt: at(31 + 20) },
        ],
        spareUnits: { pushback_tug: 1 },
        standCurfew: at(31 + 30),
      }),
    );
    expect(plan.feasible).toBe(true);
    const pushback = plan.assignments.find((a) => a.taskId === "pushback");
    expect(pushback && Date.parse(pushback.newEnd) <= Date.parse(at(61))).toBe(true);
  });
});

describe("fueling/boarding safety overlap (PRD §6)", () => {
  it("keeps boarding behind the fueling start + vapour-clearance gap", () => {
    // Both fueling and boarding still pending; fueling's hydrant is out until
    // +40 with no spare ⇒ fuel start 40; boarding may not start before +50
    // even though its deps finished at +26.
    const states = statesAtInject();
    states.delete("fueling");
    states.delete("boarding");
    const plan = planTasks(
      buildScheduleContext({
        ...loaderInput(),
        states,
        unavailableUnits: [
          { unitId: "NX-204-fuel_hydrant", kind: "fuel_hydrant", availableAt: at(40) },
          { unitId: "NX-204-baggage_loader", kind: "baggage_loader", availableAt: at(31 + 49) },
        ],
        spareUnits: { fuel_hydrant: 0, baggage_loader: 1 },
      }),
    );
    expect(plan.feasible).toBe(true);
    const boarding = plan.assignments.find((a) => a.taskId === "boarding");
    expect(boarding && Date.parse(boarding.newStart) >= Date.parse(at(50))).toBe(true);
  });
});
