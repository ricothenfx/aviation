import type { AlertSeverity } from "@aviation/contracts";

import {
  evaluateRiskRules,
  type RiskFinding,
  type RiskSnapshot,
  type RiskTaskState,
} from "./risk-rules";
import {
  FUELING_BOARDING_GAP_MIN,
  SWAP_OVERHEAD_MIN,
  planTasks,
  type ScheduleContext,
  type SchedulePlan,
  type SchedulerTask,
  type UnitUnavailability,
} from "./scheduler";
import { assignedUnitId, taskUnitKind } from "./disruptions";

/**
 * Pure assembly of scheduler/rule inputs from a turn's plan + runtime state
 * (api-contracts.md §4 input contracts). Shared by the replan engine (state
 * replayed from the event log) and the benchmark/CI fixtures — one code path,
 * no drift between what we test and what we run.
 */

export interface TaskRuntimeState {
  state: RiskTaskState;
  /** Work minutes left at `now` (blocked: remaining AFTER recovery; done: 0). */
  remainingMin: number;
  /** Recovery instant while blocked (null = indefinite, e.g. no-show). */
  blockedUntil: string | null;
}

export interface PlannedTask {
  id: string;
  type: string;
  plannedStart: string;
  plannedEnd: string;
}

export interface TurnPlanInput {
  flightId: string;
  flightNo: string;
  schedOffBlock: string;
  /** ORIGINAL planned windows (never the disrupted cascade — that is the
   * simulator's do-nothing trajectory; the scheduler plans back to plan). */
  planned: readonly PlannedTask[];
  states: ReadonlyMap<string, TaskRuntimeState>;
  dependencies: readonly { taskId: string; predecessorTaskId: string }[];
  /** Scenario time (log-derived), ISO. */
  now: string;
  unavailableUnits?: readonly UnitUnavailability[];
  spareUnits?: Readonly<Record<string, number>>;
  standCurfew?: string | null;
}

function unitIdFor(flightNo: string, kind: string | null): string | null {
  return kind === null ? null : assignedUnitId(flightNo, kind);
}

function schedulerTasks(input: TurnPlanInput): SchedulerTask[] {
  return input.planned.map((task) => {
    const runtime = input.states.get(task.id);
    const state = runtime?.state ?? "pending";
    const remainingMin =
      runtime?.remainingMin ??
      Math.max(
        0,
        Math.round((Date.parse(task.plannedEnd) - Date.parse(task.plannedStart)) / 60_000),
      );
    const unitKind = taskUnitKind(task.type);
    return {
      id: task.id,
      type: task.type,
      state,
      plannedStart: task.plannedStart,
      plannedEnd: task.plannedEnd,
      unitKind,
      unitId: unitIdFor(input.flightNo, unitKind),
      remainingMin: state === "done" ? 0 : remainingMin,
      dependsOn: input.dependencies
        .filter((dep) => dep.taskId === task.id)
        .map((dep) => dep.predecessorTaskId),
    } satisfies SchedulerTask;
  });
}

/** Scheduler input (api-contracts.md §4) from the turn plan + runtime state. */
export function buildScheduleContext(input: TurnPlanInput): ScheduleContext {
  return {
    now: input.now,
    flightId: input.flightId,
    flightNo: input.flightNo,
    schedOffBlock: input.schedOffBlock,
    tasks: schedulerTasks(input),
    unavailableUnits: input.unavailableUnits ?? [],
    spareUnits: input.spareUnits ?? {},
    swapOverheadMin: SWAP_OVERHEAD_MIN,
    fuelingBoardingGapMin: FUELING_BOARDING_GAP_MIN,
    standCurfew: input.standCurfew ?? null,
  };
}

/** Rule input (api-contracts.md §4) from the same picture. */
export function buildRiskSnapshot(input: TurnPlanInput): RiskSnapshot {
  return {
    flightId: input.flightId,
    flightNo: input.flightNo,
    schedOffBlock: input.schedOffBlock,
    now: input.now,
    tasks: schedulerTasks(input).map((task) => ({
      id: task.id,
      type: task.type,
      state: task.state,
      plannedStart: task.plannedStart,
      plannedEnd: task.plannedEnd,
      remainingMin: task.remainingMin,
      blockedUntil: input.states.get(task.id)?.blockedUntil ?? null,
    })),
    dependencies: input.dependencies,
  };
}

/** Convenience: evaluate rules + plan in one pure call (used by tests/bench). */
export function assessTurn(input: TurnPlanInput): {
  findings: RiskFinding[];
  findingsBySeverity: Record<AlertSeverity, number>;
  plan: SchedulePlan;
} {
  const findings = evaluateRiskRules(buildRiskSnapshot(input));
  const findingsBySeverity = { info: 0, warning: 0, critical: 0 } as Record<AlertSeverity, number>;
  for (const finding of findings) findingsBySeverity[finding.severity] += 1;
  return { findings, findingsBySeverity, plan: planTasks(buildScheduleContext(input)) };
}
