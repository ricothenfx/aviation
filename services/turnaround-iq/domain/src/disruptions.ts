import { type ReferenceDay, type ReferenceFlight, type ReferenceTask } from "./reference-day";

/**
 * Scripted disruption definitions (PRD F-5, milestones.md §F3 — three scripts:
 * loader breakdown, gate swap, crew no-show). Pure data + pure planning: the
 * simulator executes the amendment, the replan engine re-derives the same
 * constraint picture from the event log, so both always agree.
 *
 * The blocked window enters the log via a `task.state_changed {state:"blocked"}`
 * event carrying `blockedUntil` and (for gate swap) `standCurfew` — the log
 * fully determines any later replan (ADR-0001 determinism).
 */

export type DisruptionId = "loader-breakdown" | "gate-swap" | "crew-no-show";

export interface DisruptionDefinition {
  id: DisruptionId;
  title: string;
  description: string;
  /** Task type the script hits. */
  targetTaskType: string;
  /** Ground-unit kind knocked out (null = pure constraint, no unit). */
  unitKind: string | null;
  /** Minutes the assigned unit is out; null = indefinite (no-show). */
  unavailableForMin: number | null;
  /** Replacement units of the same kind the scheduler may assign. */
  spareUnits: number;
  /** Stand-release deadline, offset from injection (gate swap); null = none. */
  standCurfewOffsetMin: number | null;
}

export const DISRUPTION_CATALOG: readonly DisruptionDefinition[] = [
  {
    id: "loader-breakdown",
    title: "Baggage loader breakdown",
    description:
      "The assigned baggage loader fails mid-turn. Without replanning the cascade delays departure by 47 min; a spare loader exists (+5 min swap).",
    targetTaskType: "baggage_load",
    unitKind: "baggage_loader",
    unavailableForMin: 49,
    spareUnits: 1,
    standCurfewOffsetMin: null,
  },
  {
    id: "gate-swap",
    title: "Gate swap — early stand release",
    description:
      "An inbound wide-body claims the stand: this turn must release it 30 min after the call, and the pushback tug is borrowed for 20 min (spare tug +5 min swap).",
    targetTaskType: "pushback",
    unitKind: "pushback_tug",
    unavailableForMin: 20,
    spareUnits: 1,
    standCurfewOffsetMin: 30,
  },
  {
    id: "crew-no-show",
    title: "Cleaning crew no-show",
    description:
      "The cleaning crew does not report and no replacement exists in the window — the turn cannot be completed; the engine must report the conflict instead of silently violating constraints.",
    targetTaskType: "cleaning",
    unitKind: "cleaning_crew",
    unavailableForMin: null,
    spareUnits: 0,
    standCurfewOffsetMin: null,
  },
];

export function disruptionById(id: string): DisruptionDefinition | null {
  return DISRUPTION_CATALOG.find((definition) => definition.id === id) ?? null;
}

/** Ground-unit kind per task type (PRD §6 ground units). */
export function taskUnitKind(type: string): string | null {
  switch (type) {
    case "baggage_unload":
    case "baggage_load":
      return "baggage_loader";
    case "catering":
      return "catering_truck";
    case "fueling":
      return "fuel_hydrant";
    case "cleaning":
      return "cleaning_crew";
    case "pushback":
      return "pushback_tug";
    default:
      return null;
  }
}

/** Cosmetic assigned-unit id (synthetic fleet, data-ethics.md §2). */
export function assignedUnitId(flightNo: string, kind: string): string {
  return `${flightNo}-${kind}`;
}

export interface InjectTargetInput {
  flight: ReferenceFlight;
  /** True when the target task has emitted its in_progress event (watermark ≥ 1). */
  targetStarted: boolean;
}

/**
 * Deterministic disruption target: the earliest in-block, on-time flight whose
 * target task has not finished when the script fires. On-time flights keep the
 * documented baseline math exact (loader breakdown ⇒ 47 min unmanaged).
 */
export function selectInjectTarget(
  day: ReferenceDay,
  definition: DisruptionDefinition,
  scenarioNowMs: number,
  isTaskDone: (taskId: string) => boolean,
): InjectTargetInput | null {
  const candidates = day.flights
    .filter(
      (flight) =>
        flight.delayedMin === 0 &&
        Date.parse(flight.schedInBlock) <= scenarioNowMs &&
        scenarioNowMs <
          Date.parse(flight.schedOffBlock) + (definition.unavailableForMin ?? 0) * 60_000,
    )
    .sort(
      (a, b) =>
        Date.parse(a.schedInBlock) - Date.parse(b.schedInBlock) ||
        a.flightNo.localeCompare(b.flightNo),
    );
  for (const flight of candidates) {
    const target = flight.tasks.find((task) => task.type === definition.targetTaskType);
    if (target && !isTaskDone(target.id)) {
      return { flight, targetStarted: Date.parse(target.plannedStart) <= scenarioNowMs };
    }
  }
  return null;
}

export interface PlanAmendment {
  /** The blocked task + wire fields for its task.state_changed event. */
  blocked: {
    task: ReferenceTask;
    /** slaRemainingMin = recovery offset + remaining work (scheduler input). */
    slaRemainingMin: number;
    blockedUntil: string | null;
    standCurfew: string | null;
  };
  /** New planned windows for the affected + downstream not-yet-done tasks. */
  overrides: ReadonlyArray<{ taskId: string; plannedStart: string; plannedEnd: string }>;
}

/**
 * The unmanaged trajectory (architecture.md §3: simulator adopts operational
 * reality): the affected task waits out the breakdown, every not-yet-done task
 * sequenced after it slides by the same offset (serial ground-handler cascade).
 * Pure: same day + inject instant + watermarks ⇒ identical amendment.
 */
export function planDisruptionAmendment(
  definition: DisruptionDefinition,
  scenarioNowMs: number,
  target: InjectTargetInput,
  isTaskDone: (taskId: string) => boolean,
): PlanAmendment {
  const flight = target.flight;
  const affected = flight.tasks.find((task) => task.type === definition.targetTaskType);
  if (!affected)
    throw new Error(`flight ${flight.flightNo} has no ${definition.targetTaskType} task`);

  const durationMin = Math.max(
    0,
    Math.round((Date.parse(affected.plannedEnd) - Date.parse(affected.plannedStart)) / 60_000),
  );
  // Remaining work at inject: elapsed subtracted for running tasks, full duration otherwise.
  const remainingMin = target.targetStarted
    ? Math.max(0, Math.round((Date.parse(affected.plannedEnd) - scenarioNowMs) / 60_000))
    : durationMin;
  const outForMin = definition.unavailableForMin ?? 0;

  const blockedUntil =
    definition.unavailableForMin === null
      ? null
      : new Date(scenarioNowMs + definition.unavailableForMin * 60_000).toISOString();
  const standCurfew =
    definition.standCurfewOffsetMin === null
      ? null
      : new Date(scenarioNowMs + definition.standCurfewOffsetMin * 60_000).toISOString();

  // New window for the affected task.
  const newAffectedStart = target.targetStarted
    ? affected.plannedStart
    : new Date(
        Math.max(Date.parse(affected.plannedStart), scenarioNowMs + outForMin * 60_000),
      ).toISOString();
  const newAffectedEnd = target.targetStarted
    ? new Date(Date.parse(affected.plannedEnd) + outForMin * 60_000).toISOString()
    : new Date(Date.parse(newAffectedStart) + durationMin * 60_000).toISOString();

  const overrides: Array<{ taskId: string; plannedStart: string; plannedEnd: string }> = [];
  if (!isTaskDone(affected.id)) {
    overrides.push({
      taskId: affected.id,
      plannedStart: newAffectedStart,
      plannedEnd: newAffectedEnd,
    });
  }

  // Serial cascade: every later not-yet-done task of the same turn slides by the
  // outage. Done tasks are protected (watermarks already emitted their events).
  const downstream = flight.tasks
    .filter(
      (task) =>
        task.id !== affected.id &&
        !isTaskDone(task.id) &&
        Date.parse(task.plannedStart) >= Date.parse(affected.plannedStart),
    )
    .sort(
      (a, b) => Date.parse(a.plannedStart) - Date.parse(b.plannedStart) || a.id.localeCompare(b.id),
    );
  for (const task of downstream) {
    overrides.push({
      taskId: task.id,
      plannedStart: new Date(Date.parse(task.plannedStart) + outForMin * 60_000).toISOString(),
      plannedEnd: new Date(Date.parse(task.plannedEnd) + outForMin * 60_000).toISOString(),
    });
  }

  return {
    blocked: {
      task: affected,
      slaRemainingMin: outForMin + remainingMin,
      blockedUntil,
      standCurfew,
    },
    overrides,
  };
}
