import { createHash } from "node:crypto";

/**
 * Constraint scheduler (api-contracts.md §4): "remaining tasks + constraints
 * (deps, unit availability, fuel/boarding overlap, stand curfew) → feasible
 * plan minimizing Σdelay; infeasible → {plan|null, conflicts[]}".
 *
 * Pure and deterministic (PRD F-4, milestones.md §F3): same context ⇒
 * byte-identical plan ⇒ identical plan hash (CI-tested). Tasks are scheduled in
 * topological order with (plannedStart, id) tie-breaks; every decision is a
 * deterministic max/earliest-fit — no search, no randomness, well under the
 * 2 s budget for a 12-task turn (PRD §5).
 *
 * Delay definition (honest, documented): totalDelayMin = projected departure
 * slip = pushback finish − schedOffBlock. baselineDelayMin = the same measure
 * for the do-nothing trajectory (keep the assigned unit, wait out the
 * breakdown). The KPI "delay minutes saved" = baseline − plan on approval.
 */

export const SWAP_OVERHEAD_MIN = 5;
export const FUELING_BOARDING_GAP_MIN = 10;

export interface SchedulerTask {
  id: string;
  type: string;
  state: "pending" | "in_progress" | "blocked" | "done";
  plannedStart: string;
  plannedEnd: string;
  /** Ground-unit kind this task needs (null = no unit, e.g. document_check). */
  unitKind: string | null;
  /** Currently assigned unit (cosmetic id; availability is tracked per unit). */
  unitId: string | null;
  /** Work minutes left at `now` (full duration for pending tasks). */
  remainingMin: number;
  dependsOn: readonly string[];
}

export interface UnitUnavailability {
  unitId: string;
  kind: string;
  /** Unit usable again from this scenario time; null = indefinite (no-show). */
  availableAt: string | null;
}

export interface ScheduleContext {
  now: string;
  flightId: string;
  flightNo: string;
  schedOffBlock: string;
  /** Full turn; done tasks anchor dependency math and are never re-planned. */
  tasks: readonly SchedulerTask[];
  unavailableUnits: readonly UnitUnavailability[];
  /** Replacement units by kind (disruption catalog — disruptions.ts). */
  spareUnits: Readonly<Record<string, number>>;
  swapOverheadMin: number;
  fuelingBoardingGapMin: number;
  /** Stand must be released by this scenario time (gate swap); null = none. */
  standCurfew: string | null;
}

export interface PlanAssignment {
  taskId: string;
  newStart: string;
  newEnd: string;
  unitId: string | null;
  reassigned: boolean;
}

export interface SchedulePlan {
  feasible: boolean;
  assignments: PlanAssignment[];
  /** Projected departure slip with the plan applied (−1 when infeasible). */
  totalDelayMin: number;
  /** Departure slip of the do-nothing trajectory (−1 when unprojectable). */
  baselineDelayMin: number;
  /** Unresolvable constraints — never empty when feasible is false. */
  conflicts: string[];
  rationale: string;
}

const MIN = 60_000;

interface Projection {
  startBy: Map<string, string>;
  endBy: Map<string, string>;
  unitBy: Map<string, { unitId: string | null; reassigned: boolean }>;
  conflicts: string[];
  unprojectable: Set<string>;
}

/** Deterministic topological order: Kahn's algorithm with (plannedStart, id) tie-breaks. */
function topoOrder(tasks: readonly SchedulerTask[]): SchedulerTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const pending = new Set(tasks.map((task) => task.id));
  const ordered: SchedulerTask[] = [];
  while (pending.size > 0) {
    const ready = tasks
      .filter(
        (task) =>
          pending.has(task.id) &&
          task.dependsOn.every((dep) => !pending.has(dep) || !byId.has(dep)),
      )
      .sort(
        (a, b) =>
          Date.parse(a.plannedStart) - Date.parse(b.plannedStart) || a.id.localeCompare(b.id),
      );
    if (ready.length === 0) {
      // Cycle guard (dependencies are cycle-checked at insert — data-model.md §2).
      throw new Error("dependency cycle detected in scheduler input");
    }
    for (const task of ready) {
      pending.delete(task.id);
      ordered.push(task);
    }
  }
  return ordered;
}

/**
 * Project the whole turn under a unit policy. `allowReassignment` = the managed
 * plan (spare units + swap overhead); without it we get the do-nothing baseline.
 */
function projectTurn(context: ScheduleContext, allowReassignment: boolean): Projection {
  const result: Projection = {
    startBy: new Map(),
    endBy: new Map(),
    unitBy: new Map(),
    conflicts: [],
    unprojectable: new Set(),
  };
  const unavailableByUnit = new Map(context.unavailableUnits.map((unit) => [unit.unitId, unit]));
  const spareFreeAt = new Map<string, number>();
  let spareCounter = 0;

  for (const task of topoOrder(context.tasks)) {
    if (task.state === "done") {
      result.endBy.set(task.id, task.plannedEnd);
      result.startBy.set(task.id, task.plannedStart);
      continue;
    }
    // A predecessor that can never run makes this task unprojectable too.
    const brokenDeps = task.dependsOn.filter((dep) => result.unprojectable.has(dep));
    if (brokenDeps.length > 0) {
      result.unprojectable.add(task.id);
      result.conflicts.push(`dependency_unresolved:${task.type}:${task.id}`);
      continue;
    }

    let earliest = Date.parse(context.now);
    for (const dep of task.dependsOn) {
      const end = result.endBy.get(dep);
      if (end) earliest = Math.max(earliest, Date.parse(end));
    }

    if (task.state === "in_progress") {
      // Already running: the assigned unit stays; work finishes after remaining.
      const start = earliest;
      const end = start + Math.max(0, task.remainingMin) * MIN;
      result.startBy.set(task.id, new Date(start).toISOString());
      result.endBy.set(task.id, new Date(end).toISOString());
      result.unitBy.set(task.id, { unitId: task.unitId, reassigned: false });
      continue;
    }

    // pending | blocked: needs its unit (when the task type has one) before work.
    const unavailability = task.unitId ? unavailableByUnit.get(task.unitId) : undefined;
    // availableAt null = indefinite (e.g. crew no-show): never staffable again.
    const indefinite = unavailability?.availableAt === null;
    const unitBusyUntil =
      unavailability && unavailability.availableAt !== null
        ? Date.parse(unavailability.availableAt)
        : null;
    const needsUnitNow =
      task.unitKind !== null &&
      (indefinite || (unitBusyUntil !== null && unitBusyUntil > earliest));
    const spareCount = context.spareUnits[task.unitKind ?? ""] ?? 0;

    if (needsUnitNow && allowReassignment && spareCount > 0) {
      // Reassign a replacement unit; repositioning takes the swap overhead.
      const freeAt = spareFreeAt.get(task.unitKind ?? "") ?? Date.parse(context.now);
      const readyAt = Date.parse(context.now) + context.swapOverheadMin * MIN;
      const start = Math.max(earliest, readyAt, freeAt);
      const end = start + Math.max(0, task.remainingMin) * MIN;
      spareCounter += 1;
      const unitId = `${task.unitKind}-spare-${spareCounter}`;
      spareFreeAt.set(task.unitKind ?? "", end);
      result.startBy.set(task.id, new Date(start).toISOString());
      result.endBy.set(task.id, new Date(end).toISOString());
      result.unitBy.set(task.id, { unitId, reassigned: true });
      continue;
    }

    if (needsUnitNow && indefinite) {
      result.unprojectable.add(task.id);
      // Only the managed plan reports the conflict; the baseline just fails to project.
      if (allowReassignment) {
        result.conflicts.push(`unit_unavailable:${task.unitKind ?? "unknown"}:${task.id}`);
      }
      continue;
    }

    const start =
      needsUnitNow && unitBusyUntil !== null ? Math.max(earliest, unitBusyUntil) : earliest;
    const end = start + Math.max(0, task.remainingMin) * MIN;
    result.startBy.set(task.id, new Date(start).toISOString());
    result.endBy.set(task.id, new Date(end).toISOString());
    result.unitBy.set(task.id, { unitId: task.unitId, reassigned: false });
  }

  // Safety constraint (PRD §6): boarding starts no earlier than the fueling
  // start + vapour-clearance gap — only enforced when the scheduler actually
  // (re)places boarding, never retroactively on running tasks.
  const boarding = context.tasks.find((task) => task.type === "boarding");
  const fueling = context.tasks.find((task) => task.type === "fueling");
  if (
    allowReassignment &&
    boarding &&
    fueling &&
    boarding.state !== "done" &&
    boarding.state !== "in_progress" &&
    fueling.state !== "done"
  ) {
    const fuelStart = result.startBy.get(fueling.id);
    const boardingStart = result.startBy.get(boarding.id);
    if (fuelStart && boardingStart) {
      const minStart = Date.parse(fuelStart) + context.fuelingBoardingGapMin * MIN;
      if (Date.parse(boardingStart) < minStart) {
        shiftSubtree(context, boarding.id, minStart - Date.parse(boardingStart), result);
      }
    }
  }

  // Stand curfew (gate swap): the stand must be released by the deadline.
  if (context.standCurfew) {
    const pushback = context.tasks.find((task) => task.type === "pushback");
    const pushbackEnd = pushback ? result.endBy.get(pushback.id) : undefined;
    if (pushback && pushbackEnd && Date.parse(pushbackEnd) > Date.parse(context.standCurfew)) {
      result.conflicts.push(`stand_curfew:pushback:${pushback.id}`);
    }
  }

  return result;
}

/** Push a task and everything downstream by `shiftMs` (curfew repair). */
function shiftSubtree(
  context: ScheduleContext,
  rootId: string,
  shiftMs: number,
  result: Projection,
): void {
  const moving = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of context.tasks) {
      if (moving.has(task.id) || task.state === "done") continue;
      if (task.dependsOn.some((dep) => moving.has(dep))) {
        moving.add(task.id);
        grew = true;
      }
    }
  }
  for (const taskId of moving) {
    const start = result.startBy.get(taskId);
    const end = result.endBy.get(taskId);
    if (!start || !end) continue;
    result.startBy.set(taskId, new Date(Date.parse(start) + shiftMs).toISOString());
    result.endBy.set(taskId, new Date(Date.parse(end) + shiftMs).toISOString());
  }
}

function departureDelay(context: ScheduleContext, projection: Projection): number {
  const pushback = context.tasks.find((task) => task.type === "pushback");
  if (!pushback) return 0;
  const end = projection.endBy.get(pushback.id);
  if (!end) return -1; // unprojectable (infeasible branch)
  const delay = (Date.parse(end) - Date.parse(context.schedOffBlock)) / MIN;
  return Math.max(0, Math.round(delay));
}

/** Compute the feasible plan minimizing departure delay; infeasible → conflicts. */
export function planTasks(context: ScheduleContext): SchedulePlan {
  const managed = projectTurn(context, true);
  const baseline = projectTurn(context, false);

  const assignments: PlanAssignment[] = context.tasks
    .filter((task) => task.state !== "done" && !managed.unprojectable.has(task.id))
    .map((task) => ({
      taskId: task.id,
      newStart: managed.startBy.get(task.id) ?? task.plannedStart,
      newEnd: managed.endBy.get(task.id) ?? task.plannedEnd,
      unitId: managed.unitBy.get(task.id)?.unitId ?? task.unitId,
      reassigned: managed.unitBy.get(task.id)?.reassigned ?? false,
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));

  const feasible = managed.conflicts.length === 0;
  const totalDelayMin = feasible ? departureDelay(context, managed) : -1;
  const baselineDelayMin = departureDelay(context, baseline);

  const reassignedTasks = assignments.filter((a) => a.reassigned);
  const movedTasks = assignments.filter(
    (a) =>
      Date.parse(a.newStart) !==
        Date.parse(context.tasks.find((t) => t.id === a.taskId)?.plannedStart ?? a.newStart) ||
      Date.parse(a.newEnd) !==
        Date.parse(context.tasks.find((t) => t.id === a.taskId)?.plannedEnd ?? a.newEnd),
  );
  const parts: string[] = [];
  if (reassignedTasks.length > 0) {
    parts.push(
      `reassigned ${reassignedTasks
        .map((a) => context.tasks.find((t) => t.id === a.taskId)?.type ?? a.taskId)
        .join(", ")} to spare units (+${context.swapOverheadMin} min swap)`,
    );
  }
  parts.push(
    `${movedTasks.length} task${movedTasks.length === 1 ? "" : "s"} rescheduled around open constraints`,
  );
  parts.push(
    feasible
      ? `projected departure slip ${totalDelayMin} min (do-nothing baseline ${baselineDelayMin} min)`
      : `${managed.conflicts.length} constraint(s) unresolvable`,
  );

  return {
    feasible,
    assignments,
    totalDelayMin,
    baselineDelayMin,
    conflicts: [...managed.conflicts].sort(),
    rationale: parts.join("; "),
  };
}

/** sha256 over the canonical assignment list — the determinism evidence (F3 DoD). */
export function planHash(
  plan: Pick<SchedulePlan, "assignments" | "totalDelayMin" | "feasible">,
): string {
  const hash = createHash("sha256");
  for (const assignment of plan.assignments) {
    hash.update(
      `${assignment.taskId}|${assignment.newStart}|${assignment.newEnd}|${assignment.unitId ?? ""}|${assignment.reassigned ? 1 : 0}\n`,
    );
  }
  hash.update(`${plan.totalDelayMin}|${plan.feasible ? 1 : 0}\n`);
  return hash.digest("hex");
}
