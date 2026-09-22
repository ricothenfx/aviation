import { uuidV5 } from "./ids";
import { mulberry32, pick, type Prng } from "./prng";
import { REFERENCE_DAY } from "./scenario";

/**
 * Deterministic reference-day generator (data-model.md §4: "one canonical
 * reference day"; PRD F-5: seed + scenario reset reproducible byte-identically).
 *
 * Pure function of the seed: same seed ⇒ identical stands, flights, tasks and
 * dependencies ⇒ identical event log. Flight numbers use the fictional NX /
 * NordicX brand (data-ethics.md §2, ui-design-system.md §8).
 */

export const REFERENCE_DAY_SEED = 42;

export interface ReferenceStand {
  id: string;
  code: string;
  standType: "narrow" | "wide";
  constraints: Record<string, never>;
}

export interface ReferenceAircraftType {
  id: string;
  code: string;
  turnSlaDefaults: { turnTargetMin: number; bufferMin: number };
}

export interface ReferenceTask {
  id: string;
  flightId: string;
  /** Open vocabulary per data-model.md §1 (baggage_load|catering|fueling|…). */
  type: string;
  slaMinutes: number;
  plannedStart: string;
  plannedEnd: string;
  /** Execution order within the turn (0-based, topological). */
  order: number;
}

export interface ReferenceFlight {
  id: string;
  flightNo: string;
  standId: string;
  standCode: string;
  aircraftTypeId: string;
  aircraftTypeCode: string;
  schedInBlock: string;
  schedOffBlock: string;
  /** Deterministic planned slip of this turnaround (minutes ≥ 0). */
  delayedMin: number;
  /** Cause task type when delayedMin > 0 (demo narrative; PRD §1). */
  causeTaskType: string | null;
  tasks: ReferenceTask[];
}

export interface ReferenceDependency {
  taskId: string;
  predecessorTaskId: string;
}

export interface ReferenceDay {
  seed: number;
  stands: ReferenceStand[];
  aircraftTypes: ReferenceAircraftType[];
  flights: ReferenceFlight[];
  dependencies: ReferenceDependency[];
}

export const TASK_TYPES = [
  "alighting",
  "baggage_unload",
  "cleaning",
  "lavatory_service",
  "water_service",
  "catering",
  "fueling",
  "baggage_load",
  "cabin_check",
  "document_check",
  "boarding",
  "pushback",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

/** Turn template: offsets (minutes from in-block) honoring the dependency DAG. */
interface TaskTemplate {
  type: TaskType;
  startMin: number;
  endMin: number;
  slaMinutes: number;
  dependsOn: TaskType[];
}

const TURN_TEMPLATE: readonly TaskTemplate[] = [
  { type: "alighting", startMin: 0, endMin: 12, slaMinutes: 12, dependsOn: [] },
  { type: "baggage_unload", startMin: 12, endMin: 26, slaMinutes: 14, dependsOn: ["alighting"] },
  { type: "cleaning", startMin: 12, endMin: 24, slaMinutes: 12, dependsOn: ["alighting"] },
  { type: "lavatory_service", startMin: 24, endMin: 34, slaMinutes: 10, dependsOn: ["cleaning"] },
  { type: "water_service", startMin: 24, endMin: 33, slaMinutes: 9, dependsOn: ["cleaning"] },
  { type: "catering", startMin: 12, endMin: 26, slaMinutes: 14, dependsOn: ["alighting"] },
  { type: "fueling", startMin: 14, endMin: 30, slaMinutes: 16, dependsOn: ["alighting"] },
  { type: "baggage_load", startMin: 26, endMin: 40, slaMinutes: 14, dependsOn: ["baggage_unload"] },
  { type: "cabin_check", startMin: 24, endMin: 32, slaMinutes: 8, dependsOn: ["cleaning"] },
  { type: "document_check", startMin: 30, endMin: 38, slaMinutes: 8, dependsOn: [] },
  {
    type: "boarding",
    startMin: 26,
    endMin: 42,
    slaMinutes: 16,
    dependsOn: ["cleaning", "catering"],
  },
  {
    type: "pushback",
    startMin: 42,
    endMin: 48,
    slaMinutes: 6,
    dependsOn: ["boarding", "baggage_load", "fueling"],
  },
];

export const TURN_DURATION_MIN = 48;
const FLIGHTS_PER_BANK = 20;
const BANK_START_MIN = [60, 390, 720]; // 06:00, 11:30, 17:00 UTC after day start (05:00Z)
const BANK_IN_BLOCK_SPACING_MIN = 7;
const DELAY_OPTIONS = [3, 5, 8, 12, 15] as const;
const DELAY_CAUSES = ["fueling", "catering", "baggage_unload"] as const;

const DAY_START_MS = Date.parse(`${REFERENCE_DAY}T05:00:00.000Z`);

function isoAt(offsetMin: number): string {
  return new Date(DAY_START_MS + offsetMin * 60_000).toISOString();
}

function idFor(kind: string, key: string): string {
  return uuidV5(`${kind}:${key}`);
}

export function buildReferenceDay(seed: number = REFERENCE_DAY_SEED): ReferenceDay {
  const prng: Prng = mulberry32(seed);

  const stands: ReferenceStand[] = [];
  for (let i = 1; i <= 10; i++) {
    const code = `A${i}`;
    stands.push({ id: idFor("stand", code), code, standType: "narrow", constraints: {} });
  }
  for (let i = 1; i <= 4; i++) {
    const code = `B${i}`;
    stands.push({ id: idFor("stand", code), code, standType: "wide", constraints: {} });
  }

  const aircraftTypes: ReferenceAircraftType[] = [
    {
      id: idFor("aircraft_type", "NB320"),
      code: "NB320",
      turnSlaDefaults: { turnTargetMin: 45, bufferMin: 10 },
    },
    {
      id: idFor("aircraft_type", "NB737"),
      code: "NB737",
      turnSlaDefaults: { turnTargetMin: 45, bufferMin: 10 },
    },
  ];

  const dependencies: ReferenceDependency[] = [];
  const flights: ReferenceFlight[] = [];
  // Track each stand's busy-until instant (minutes since day start) for allocation.
  const standBusyUntil = new Map<string, number>(
    stands.map((s) => [s.id, Number.NEGATIVE_INFINITY]),
  );

  let flightCounter = 0;
  for (const [bankIdx, bankStart] of BANK_START_MIN.entries()) {
    for (let i = 0; i < FLIGHTS_PER_BANK; i++) {
      flightCounter += 1;
      let inBlockMin = bankStart + i * BANK_IN_BLOCK_SPACING_MIN;
      const flightNo = `NX-${bankIdx * 100 + 100 + i}`;

      // Greedy deterministic stand allocation: prefer the earliest-free stand that
      // is already free at the planned in-block time; otherwise shift in-block.
      let chosen = stands[0] as ReferenceStand;
      let earliestFree = Number.POSITIVE_INFINITY;
      for (const stand of stands) {
        const free = standBusyUntil.get(stand.id) ?? Number.NEGATIVE_INFINITY;
        if (free <= inBlockMin) {
          chosen = stand;
          earliestFree = free;
          break;
        }
        if (free < earliestFree) {
          earliestFree = free;
          chosen = stand;
        }
      }
      if ((standBusyUntil.get(chosen.id) ?? Number.NEGATIVE_INFINITY) > inBlockMin) {
        inBlockMin = Math.ceil(earliestFree);
      }
      standBusyUntil.set(chosen.id, inBlockMin + TURN_DURATION_MIN + 20);

      const aircraftType = aircraftTypes[
        flightCounter % aircraftTypes.length
      ] as ReferenceAircraftType;
      const flightId = idFor("flight", flightNo);
      const offsetByType = new Map<TaskType, { start: number; end: number }>();
      for (const tpl of TURN_TEMPLATE) {
        offsetByType.set(tpl.type, { start: tpl.startMin, end: tpl.endMin });
      }

      // Deterministic slip: ~25 % of turns get a cause-task delay cascade.
      const isDelayed = prng() < 0.25;
      const delayedMin = isDelayed ? pick(prng, DELAY_OPTIONS) : 0;
      const causeTaskType = isDelayed ? pick(prng, DELAY_CAUSES) : null;
      const causeStart = causeTaskType
        ? (TURN_TEMPLATE.find((t) => t.type === causeTaskType)?.startMin ?? TURN_DURATION_MIN)
        : TURN_DURATION_MIN;

      const tasks: ReferenceTask[] = TURN_TEMPLATE.map((tpl, order) => {
        const shift = tpl.startMin >= causeStart ? delayedMin : 0;
        const taskId = idFor("task", `${flightId}:${tpl.type}`);
        for (const dep of tpl.dependsOn) {
          const depTask = TURN_TEMPLATE.find((t) => t.type === dep);
          if (!depTask) continue;
          dependencies.push({
            taskId,
            predecessorTaskId: idFor("task", `${flightId}:${dep}`),
          });
        }
        return {
          id: taskId,
          flightId,
          type: tpl.type,
          slaMinutes: tpl.slaMinutes,
          plannedStart: isoAt(inBlockMin + tpl.startMin + shift),
          plannedEnd: isoAt(inBlockMin + tpl.endMin + shift),
          order,
        };
      });

      flights.push({
        id: flightId,
        flightNo,
        standId: chosen.id,
        standCode: chosen.code,
        aircraftTypeId: aircraftType.id,
        aircraftTypeCode: aircraftType.code,
        schedInBlock: isoAt(inBlockMin),
        schedOffBlock: isoAt(inBlockMin + TURN_DURATION_MIN),
        delayedMin,
        causeTaskType,
        tasks,
      });
    }
  }

  assertAcyclic(flights, dependencies);
  return { seed, stands, aircraftTypes, flights, dependencies };
}

/** Guard required by data-model.md §2: dependencies are cycle-checked at insert. */
export function assertAcyclic(
  flights: readonly ReferenceFlight[],
  dependencies: readonly ReferenceDependency[],
): void {
  const depsOf = new Map<string, string[]>();
  for (const dep of dependencies) {
    const list = depsOf.get(dep.taskId);
    if (list) list.push(dep.predecessorTaskId);
    else depsOf.set(dep.taskId, [dep.predecessorTaskId]);
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (taskId: string): void => {
    const st = state.get(taskId);
    if (st === "done") return;
    if (st === "visiting") throw new Error(`dependency cycle detected at task ${taskId}`);
    state.set(taskId, "visiting");
    for (const pred of depsOf.get(taskId) ?? []) visit(pred);
    state.set(taskId, "done");
  };
  for (const flight of flights) for (const task of flight.tasks) visit(task.id);
}

/** Planned off-block (pushback planned end) for a flight — the plan's projection. */
export function plannedOffBlockIso(flight: ReferenceFlight): string {
  const pushback = flight.tasks.find((t) => t.type === "pushback");
  return pushback ? pushback.plannedEnd : flight.schedOffBlock;
}
