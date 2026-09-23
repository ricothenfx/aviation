import {
  eventPayloadSchemas,
  type AlertLifecyclePayload,
  type DomainEvent,
  type EventPayloadMap,
  type EventType,
  type FlightDelayRiskPayload,
  type FlightStatus,
  type KpiUpdatedPayload,
  type ReplanApprovedPayload,
  type ReplanProposedPayload,
  type ReplanRejectedPayload,
  type ScenarioTickPayload,
  type TaskRescheduledPayload,
  type TaskStateChangedPayload,
  type TurnStartedPayload,
} from "@aviation/contracts";

import { plannedOffBlockIso, type ReferenceDay } from "./reference-day";

/**
 * Pure projection logic (ADR-0001): events are the only input; no I/O, no clock,
 * no randomness. The realtime-gateway worker persists the result to Redis; the
 * golden replay test feeds the FULL event log through the same functions.
 *
 * Design notes:
 * - `kpi.updated`, `scenario.tick` and `flight.delay_risk` are DERIVED frames the
 *   worker emits on the wire; they never enter event_log (the log holds state
 *   changes only). applyEvent still accepts them so replay and live frames share
 *   one code path (PRD F-6: KPIs derived from projections).
 */

export interface TaskProjection {
  id: string;
  flightId: string;
  type: string;
  state: "pending" | "in_progress" | "done" | "blocked";
  slaMinutes: number;
  plannedStart: string;
  plannedEnd: string;
}

export interface FlightProjection {
  id: string;
  flightNo: string;
  standId: string;
  standCode: string;
  aircraftTypeCode: string;
  schedInBlock: string;
  schedOffBlock: string;
  estOffBlock: string | null;
  status: FlightStatus;
  delayedMin: number;
  tasks: TaskProjection[];
}

export interface AlertProjection {
  id: string;
  flightId: string;
  ruleId: string;
  severity: "info" | "warning" | "critical";
  state: "raised" | "acknowledged" | "resolved";
  raisedAt: string;
  leadTimeMin: number | null;
}

export interface Kpis {
  onTimeDepPct: number;
  avgTurnMin: number;
  activeAlerts: number;
  delayMinutesSaved: number;
}

/** Replan proposal tracked in the projection (F3 lifecycle proposed|approved|rejected). */
export interface ReplanProjection {
  payload: ReplanProposedPayload;
  status: "proposed" | "approved" | "rejected";
}

export interface BoardProjectionState {
  scenarioTs: string | null;
  scenarioSpeed: number | null;
  flights: Map<string, FlightProjection>;
  alerts: Map<string, AlertProjection>;
  replans: Map<string, ReplanProjection>;
  kpis: Kpis | null;
}

export function emptyProjectionState(): BoardProjectionState {
  return {
    scenarioTs: null,
    scenarioSpeed: null,
    flights: new Map(),
    alerts: new Map(),
    replans: new Map(),
    kpis: null,
  };
}

/**
 * Baseline state built from the reference day (planned data as seeded). This is
 * the pre-scenario board and the starting point for event replay.
 */
export function initialStateFromReferenceDay(day: ReferenceDay): BoardProjectionState {
  const state = emptyProjectionState();
  const standCodeById = new Map(day.stands.map((s) => [s.id, s.code]));
  const typeCodeById = new Map(day.aircraftTypes.map((t) => [t.id, t.code]));
  for (const flight of day.flights) {
    const planned = plannedOffBlockIso(flight);
    const delayedMin = Math.max(
      0,
      Math.round((Date.parse(planned) - Date.parse(flight.schedOffBlock)) / 60_000),
    );
    state.flights.set(flight.id, {
      id: flight.id,
      flightNo: flight.flightNo,
      standId: flight.standId,
      standCode: standCodeById.get(flight.standId) ?? "?",
      aircraftTypeCode: typeCodeById.get(flight.aircraftTypeId) ?? "?",
      schedInBlock: flight.schedInBlock,
      schedOffBlock: flight.schedOffBlock,
      estOffBlock: planned,
      status: delayedMin > 0 ? "delayed" : "scheduled",
      delayedMin,
      tasks: flight.tasks.map((task) => ({
        id: task.id,
        flightId: flight.id,
        type: task.type,
        state: "pending",
        slaMinutes: task.slaMinutes,
        plannedStart: task.plannedStart,
        plannedEnd: task.plannedEnd,
      })),
    });
  }
  return state;
}

const PUSHBACK_TASK_TYPE = "pushback";

function minutesBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000);
}

/** Display status: `delayed` overrides the in-flight phases while a slip exists. */
function displayStatus(flight: FlightProjection): FlightStatus {
  if (flight.status === "off_block") return "off_block";
  if (flight.delayedMin > 0) return "delayed";
  return flight.status;
}

/**
 * After an approved replan moves remaining tasks, the projected off-block is the
 * (possibly shifted) pushback planned end — unless the aircraft already left.
 */
function refreshProjectedDeparture(flight: FlightProjection): void {
  if (flight.status === "off_block") return;
  const pushback = flight.tasks.find((task) => task.type === PUSHBACK_TASK_TYPE);
  if (!pushback || pushback.state === "done") return;
  flight.estOffBlock = pushback.plannedEnd;
  flight.delayedMin = Math.max(0, minutesBetween(flight.schedOffBlock, flight.estOffBlock));
  flight.status = displayStatus(flight);
}

/**
 * Apply one typed event to the state (mutating the in-memory structures it owns —
 * callers thread a single state instance; replay order is strictly by seq).
 * Returns the state for chaining. Unknown payloads throw (contract violation).
 */
export function applyEvent<K extends EventType>(
  state: BoardProjectionState,
  event: DomainEvent & { type: K; payload: EventPayloadMap[K] },
): BoardProjectionState {
  switch (event.type) {
    case "turn.started": {
      const payload = event.payload as TurnStartedPayload;
      const flight = state.flights.get(payload.flightId);
      if (flight && (flight.status === "scheduled" || flight.status === "delayed")) {
        flight.status = "in_block";
      }
      break;
    }
    case "task.state_changed": {
      const payload = event.payload as TaskStateChangedPayload;
      const flight = state.flights.get(payload.flightId);
      const task = flight?.tasks.find((t) => t.id === payload.taskId);
      if (flight && task) {
        task.state = payload.state;
        if (payload.state === "in_progress" && flight.status === "in_block") {
          flight.status = "turnaround";
        }
        if (task.type === PUSHBACK_TASK_TYPE && payload.state === "done") {
          flight.status = "off_block";
          flight.estOffBlock = payload.scenarioTs;
        }
        flight.delayedMin =
          flight.estOffBlock === null
            ? 0
            : Math.max(0, minutesBetween(flight.schedOffBlock, flight.estOffBlock));
        flight.status = displayStatus(flight);
      }
      break;
    }
    case "flight.delay_risk": {
      const payload = event.payload as FlightDelayRiskPayload;
      const flight = state.flights.get(payload.flightId);
      if (flight) {
        flight.estOffBlock = payload.projectedOffBlock;
        flight.delayedMin = Math.max(0, Math.round(payload.delayMin));
        flight.status = displayStatus(flight);
      }
      break;
    }
    case "alert.raised":
    case "alert.acknowledged":
    case "alert.resolved": {
      const payload = event.payload as AlertLifecyclePayload;
      const existing = state.alerts.get(payload.alertId);
      const stateByEvent: AlertProjection["state"] =
        event.type === "alert.raised"
          ? "raised"
          : event.type === "alert.acknowledged"
            ? "acknowledged"
            : "resolved";
      state.alerts.set(payload.alertId, {
        id: payload.alertId,
        flightId: payload.flightId,
        ruleId: payload.ruleId,
        severity: payload.severity,
        state: stateByEvent,
        raisedAt: existing?.raisedAt ?? event.occurredAt,
        leadTimeMin: payload.leadTimeMin,
      });
      break;
    }
    case "task.rescheduled": {
      const payload = event.payload as TaskRescheduledPayload;
      const flight = state.flights.get(payload.flightId);
      const task = flight?.tasks.find((t) => t.id === payload.taskId);
      if (flight && task && task.state !== "done") {
        task.plannedStart = payload.newStart;
        task.plannedEnd = payload.newEnd;
        refreshProjectedDeparture(flight);
      }
      break;
    }
    case "replan.proposed": {
      const payload = event.payload as ReplanProposedPayload;
      state.replans.set(payload.replanId, { payload, status: "proposed" });
      break;
    }
    case "replan.approved":
    case "replan.rejected": {
      const payload = event.payload as ReplanApprovedPayload | ReplanRejectedPayload;
      const existing = state.replans.get(payload.replanId);
      if (existing) {
        existing.status = event.type === "replan.approved" ? "approved" : "rejected";
      }
      break;
    }
    case "kpi.updated": {
      const payload = event.payload as KpiUpdatedPayload;
      state.kpis = { ...payload };
      break;
    }
    case "scenario.tick": {
      const payload = event.payload as ScenarioTickPayload;
      if (state.scenarioTs === null || payload.scenarioTs > state.scenarioTs) {
        state.scenarioTs = payload.scenarioTs;
      }
      state.scenarioSpeed = payload.speed;
      break;
    }
    default: {
      // Exhaustiveness guard — a new event type must be handled here explicitly.
      const exhaustive: never = event.type;
      throw new Error(`unhandled event type: ${String(exhaustive)}`);
    }
  }
  return state;
}

/** Apply a raw envelope by looking up the typed payload schema (worker path). */
export function applyRawEvent(
  state: BoardProjectionState,
  event: DomainEvent,
): BoardProjectionState {
  const payloadSchema = eventPayloadSchemas[event.type];
  const payload = payloadSchema.parse(event.payload);
  return applyEvent(state, {
    ...event,
    payload,
  } as DomainEvent & { type: EventType; payload: EventPayloadMap[EventType] });
}

/**
 * KPI derivation (PRD F-6: honest definitions, counts derived from projections).
 * - onTimeDepPct: share of off-block flights that left on time (delayedMin == 0).
 * - avgTurnMin: mean actual turn (estOffBlock − schedInBlock) of off-block flights.
 * - activeAlerts: alerts in raised/acknowledged state.
 * - delayMinutesSaved: Σ over APPROVED replans of (baseline − applied) — the
 *   departure slip the do-nothing trajectory would have produced minus the slip
 *   the approved plan applies. Zero until F3 replans are approved.
 */
export function deriveKpis(state: BoardProjectionState): Kpis {
  let departed = 0;
  let onTime = 0;
  let turnTotalMin = 0;
  for (const flight of state.flights.values()) {
    if (flight.status !== "off_block" || flight.estOffBlock === null) continue;
    departed += 1;
    if (flight.delayedMin === 0) onTime += 1;
    turnTotalMin += minutesBetween(flight.schedInBlock, flight.estOffBlock);
  }
  let activeAlerts = 0;
  for (const alert of state.alerts.values()) {
    if (alert.state !== "resolved") activeAlerts += 1;
  }
  let delayMinutesSaved = 0;
  for (const replan of state.replans.values()) {
    if (replan.status !== "approved") continue;
    const baseline = replan.payload.baselineDelayMin ?? replan.payload.totalDelayMin;
    delayMinutesSaved += Math.max(0, baseline - replan.payload.totalDelayMin);
  }
  return {
    onTimeDepPct: departed === 0 ? 0 : Math.round((onTime / departed) * 1000) / 10,
    avgTurnMin: departed === 0 ? 0 : Math.round((turnTotalMin / departed) * 10) / 10,
    activeAlerts,
    delayMinutesSaved,
  };
}

export interface SnapshotOptions {
  generatedAt: string;
  live: boolean;
}

/** Serialize a plain object matching contracts boardSnapshotSchema (no zod here —
 * the REST layer parses/validates against the contract schema before responding). */
export function toBoardSnapshot(
  state: BoardProjectionState,
  options: SnapshotOptions,
): {
  generatedAt: string;
  scenarioTs: string | null;
  live: boolean;
  flights: FlightProjection[];
  kpis: Kpis | null;
} {
  const flights = [...state.flights.values()].sort(
    (a, b) =>
      Date.parse(a.schedInBlock) - Date.parse(b.schedInBlock) ||
      a.flightNo.localeCompare(b.flightNo),
  );
  return {
    generatedAt: options.generatedAt,
    scenarioTs: state.scenarioTs,
    live: options.live,
    flights,
    kpis: state.kpis,
  };
}
