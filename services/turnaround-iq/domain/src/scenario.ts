import type { ScenarioSpeed } from "@aviation/contracts";

/**
 * Scenario clock + catalog (architecture.md §3–4). The simulator owns scenario
 * time; all SLA math uses scenario time serialized in events — no client
 * wall-clock math.
 */

/** The canonical simulated day (data-model.md §4: one reference day per scenario). */
export const REFERENCE_DAY = "2026-09-22";

/** Scenario window boundaries (ISO instants). */
export const DAY_START_ISO = `${REFERENCE_DAY}T05:00:00.000Z`;
export const DAY_END_ISO = `${REFERENCE_DAY}T21:00:00.000Z`;

export const DAY_START_MS = Date.parse(DAY_START_ISO);
export const DAY_END_MS = Date.parse(DAY_END_ISO);

export const SCENARIO_SPEEDS: readonly ScenarioSpeed[] = [1, 5, 20];
export const DEFAULT_SPEED: ScenarioSpeed = 5;

export const REFERENCE_SCENARIO_ID = "reference-day";

export interface ScenarioCatalogEntry {
  id: string;
  title: string;
  description: string;
}

export const SCENARIO_CATALOG: readonly ScenarioCatalogEntry[] = [
  {
    id: REFERENCE_SCENARIO_ID,
    title: "Reference day — full turnaround bank",
    description:
      "One synthetic day (05:00–21:00 UTC) with 60 narrow-body turnarounds across three banks. Some tasks slip deterministically so delayed departures are visible on the board.",
  },
];

export type ScenarioStatus = "idle" | "running" | "completed";

/** Outcome of a disruption injection, mirrored for the REST caller (F3). */
export interface InjectOutcome {
  requestId: string;
  disruptionId: string;
  status: "applied" | "no_target";
  /** Flight the script hit (null when no active turnaround matched). */
  flightNo: string | null;
  /** Wall-clock instant of the attempt (control-plane metadata, not scenario time). */
  at: string;
}

/**
 * Scenario state mirrored into Redis (`scenario:state`) so the REST layer can
 * report status without talking to the simulator process directly.
 */
export interface ScenarioClockState {
  scenarioId: string;
  status: ScenarioStatus;
  speed: ScenarioSpeed;
  /** Current scenario clock reading (ISO) or null while idle. */
  scenarioNow: string | null;
  /** Wall-clock millisecond reading the scenarioNow was computed at. */
  lastWallMs: number | null;
  /** sha256 over the canonical event log (event-log-hash.ts). */
  logHash: string | null;
  /** Last disruption-injection outcome (F3, additive). */
  lastInject: InjectOutcome | null;
}

export function initialScenarioState(scenarioId: string): ScenarioClockState {
  return {
    scenarioId,
    status: "idle",
    speed: DEFAULT_SPEED,
    scenarioNow: null,
    lastWallMs: null,
    logHash: null,
    lastInject: null,
  };
}

/**
 * Advance the scenario clock by elapsed wall time × speed (architecture.md §4).
 * Pure: returns a new state; clamps at DAY_END and flags completion.
 */
export function advanceScenarioClock(
  state: ScenarioClockState,
  wallNowMs: number,
): ScenarioClockState {
  if (state.status !== "running" || state.lastWallMs === null || state.scenarioNow === null) {
    return state;
  }
  const elapsedWallMs = Math.max(0, wallNowMs - state.lastWallMs);
  const scenarioMs = Date.parse(state.scenarioNow) + elapsedWallMs * state.speed;
  const clamped = Math.min(scenarioMs, DAY_END_MS);
  return {
    ...state,
    scenarioNow: new Date(clamped).toISOString(),
    lastWallMs: wallNowMs,
    status: clamped >= DAY_END_MS ? "completed" : "running",
  };
}

/** Scenario start position: the beginning of the operating day. */
export function scenarioStartIso(): string {
  return DAY_START_ISO;
}
