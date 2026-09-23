import { buildReferenceDay, type ReferenceFlight } from "./reference-day";
import { disruptionById, planDisruptionAmendment, assignedUnitId } from "./disruptions";
import { evaluateRiskRules } from "./risk-rules";
import { buildRiskSnapshot, buildScheduleContext } from "./scheduler-context";
import { planHash, planTasks } from "./scheduler";

/**
 * Canonical loader-breakdown benchmark (milestones.md §F3 DoD: "total delay
 * 47 → ≤ 9 min; computation < 2 s" on the loader-breakdown script).
 *
 * Pure pipeline, identical to the live propose path: reference day → inject at
 * baggage_load start + 5 min → do-nothing cascade (simulator amendment) →
 * scheduler context rebuilt from plan + blocked event → plan + hash.
 */

export interface ReplanBenchmarkResult {
  flightNo: string;
  injectAt: string;
  baselineDelayMin: number;
  totalDelayMin: number;
  planHash: string;
  alertLeadTimeMin: number;
  computeMs: number;
  assignments: number;
}

/** Deterministic canonical target: first on-time flight of the day (seed 42). */
export function canonicalBenchmarkFlight(day = buildReferenceDay()): ReferenceFlight {
  const flight = day.flights.find((candidate) => candidate.delayedMin === 0);
  if (!flight) throw new Error("reference day has no on-time flight for the benchmark");
  return flight;
}

export function runReplanBenchmark(day = buildReferenceDay()): ReplanBenchmarkResult {
  const definition = disruptionById("loader-breakdown");
  if (!definition) throw new Error("loader-breakdown definition missing");
  const flight = canonicalBenchmarkFlight(day);
  const load = flight.tasks.find((task) => task.type === "baggage_load");
  if (!load) throw new Error(`flight ${flight.flightNo} has no baggage_load task`);

  const nowMs = Date.parse(load.plannedStart) + 5 * 60_000;
  const isTaskDone = (taskId: string): boolean => {
    const task = flight.tasks.find((candidate) => candidate.id === taskId);
    return !!task && Date.parse(task.plannedEnd) <= nowMs;
  };
  const target = { flight, targetStarted: true };
  const amendment = planDisruptionAmendment(definition, nowMs, target, isTaskDone);

  // Simulator watermarks at inject: done tasks hold 2, running tasks 1.
  const watermarks = new Map<string, number>();
  for (const task of flight.tasks) {
    if (Date.parse(task.plannedEnd) <= nowMs) watermarks.set(task.id, 2);
    else if (Date.parse(task.plannedStart) <= nowMs) watermarks.set(task.id, 1);
  }

  const states = new Map<
    string,
    {
      state: "pending" | "in_progress" | "blocked" | "done";
      remainingMin: number;
      blockedUntil: string | null;
    }
  >();
  for (const task of flight.tasks) {
    const wm = watermarks.get(task.id) ?? 0;
    if (wm >= 2) {
      states.set(task.id, { state: "done", remainingMin: 0, blockedUntil: null });
    } else if (wm >= 1) {
      states.set(task.id, {
        state: "in_progress",
        remainingMin: Math.round((Date.parse(task.plannedEnd) - nowMs) / 60_000),
        blockedUntil: null,
      });
    }
  }
  const outForMin = definition.unavailableForMin ?? 0;
  states.set(load.id, {
    state: "blocked",
    // scheduler wants the WORK left after recovery: slaRemainingMin − outage
    remainingMin: amendment.blocked.slaRemainingMin - outForMin,
    blockedUntil: amendment.blocked.blockedUntil,
  });

  const kind = definition.unitKind ?? "";
  const input = {
    flightId: flight.id,
    flightNo: flight.flightNo,
    schedOffBlock: flight.schedOffBlock,
    planned: flight.tasks.map((task) => ({
      id: task.id,
      type: task.type,
      plannedStart: task.plannedStart,
      plannedEnd: task.plannedEnd,
    })),
    states,
    dependencies: day.dependencies.filter((dep) =>
      flight.tasks.some((task) => task.id === dep.taskId),
    ),
    now: new Date(nowMs).toISOString(),
    unavailableUnits: [
      {
        unitId: assignedUnitId(flight.flightNo, kind),
        kind,
        availableAt: amendment.blocked.blockedUntil,
      },
    ],
    spareUnits: { [kind]: definition.spareUnits },
    standCurfew: amendment.blocked.standCurfew,
  };

  const started = performance.now();
  const plan = planTasks(buildScheduleContext(input));
  const hash = planHash(plan);
  const computeMs = performance.now() - started;

  const findings = evaluateRiskRules(buildRiskSnapshot(input));
  const departureFinding = findings.find((finding) => finding.ruleId === "departure.at_risk");

  return {
    flightNo: flight.flightNo,
    injectAt: new Date(nowMs).toISOString(),
    baselineDelayMin: plan.baselineDelayMin,
    totalDelayMin: plan.totalDelayMin,
    planHash: hash,
    alertLeadTimeMin: departureFinding?.leadTimeMin ?? 0,
    computeMs: Math.round(computeMs * 1000) / 1000,
    assignments: plan.assignments.length,
  };
}
