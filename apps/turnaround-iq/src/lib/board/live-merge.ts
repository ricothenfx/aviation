import type { BoardSnapshot, FlightProjection, WsFrame } from "@aviation/contracts";

/**
 * Client-side delta merge (api-contracts.md §3): ws frames mutate the last known
 * board snapshot between REST refetches. Pure + synchronous — unit-tested; the
 * REST snapshot remains the source of truth on (re)connect.
 *
 * Status derivation mirrors services/turnaround-iq/domain projections so a frame
 * stream and a replay agree on what the board shows.
 */

const PUSHBACK_TASK_TYPE = "pushback";

function minutesBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000);
}

function displayStatus(flight: FlightProjection): FlightProjection {
  let status = flight.status;
  if (status !== "off_block" && flight.delayedMin > 0) status = "delayed";
  return status === flight.status ? flight : { ...flight, status };
}

export function mergeFrameIntoSnapshot(snapshot: BoardSnapshot, frame: WsFrame): BoardSnapshot {
  switch (frame.type) {
    case "scenario.tick": {
      const payload = frame.payload as { scenarioTs?: string };
      if (!payload.scenarioTs) return snapshot;
      return { ...snapshot, live: true, scenarioTs: payload.scenarioTs };
    }
    case "kpi.updated": {
      return { ...snapshot, kpis: frame.payload as BoardSnapshot["kpis"] };
    }
    case "turn.started": {
      const payload = frame.payload as { flightId?: string };
      return updateFlight(snapshot, payload.flightId, (flight) =>
        displayStatus({
          ...flight,
          status:
            flight.status === "scheduled" || flight.status === "delayed"
              ? "in_block"
              : flight.status,
        }),
      );
    }
    case "task.state_changed": {
      const payload = frame.payload as {
        flightId?: string;
        taskId?: string;
        state?: "pending" | "in_progress" | "done" | "blocked";
        scenarioTs?: string;
      };
      if (!payload.flightId || !payload.taskId || !payload.state) return snapshot;
      return updateFlight(snapshot, payload.flightId, (flight) => {
        const tasks = flight.tasks.map((task) =>
          task.id === payload.taskId
            ? { ...task, state: payload.state as typeof task.state }
            : task,
        );
        const startedProgress = tasks.some((t) => t.state !== "pending");
        const pushbackDone = tasks.some((t) => t.type === PUSHBACK_TASK_TYPE && t.state === "done");
        let estOffBlock = flight.estOffBlock;
        let status = flight.status;
        if (pushbackDone && payload.scenarioTs) {
          estOffBlock = payload.scenarioTs;
          status = "off_block";
        } else if (startedProgress && (status === "in_block" || status === "scheduled")) {
          status = "turnaround";
        }
        const delayedMin =
          estOffBlock === null ? 0 : Math.max(0, minutesBetween(flight.schedOffBlock, estOffBlock));
        return displayStatus({ ...flight, tasks, estOffBlock, status, delayedMin });
      });
    }
    case "flight.delay_risk": {
      const payload = frame.payload as {
        flightId?: string;
        projectedOffBlock?: string;
        delayMin?: number;
      };
      if (!payload.flightId || !payload.projectedOffBlock || payload.delayMin === undefined)
        return snapshot;
      return updateFlight(snapshot, payload.flightId, (flight) =>
        displayStatus({
          ...flight,
          estOffBlock: payload.projectedOffBlock as string,
          delayedMin: Math.max(0, Math.round(payload.delayMin as number)),
        }),
      );
    }
    default:
      // alert.* and replan.* frames do not change the board snapshot (F3 UI).
      return snapshot;
  }
}

function updateFlight(
  snapshot: BoardSnapshot,
  flightId: string | undefined,
  update: (flight: FlightProjection) => FlightProjection,
): BoardSnapshot {
  if (!flightId) return snapshot;
  let updated = false;
  const flights = snapshot.flights.map((flight) => {
    if (flight.id !== flightId) return flight;
    updated = true;
    return update(flight);
  });
  return updated ? { ...snapshot, flights } : snapshot;
}

/** SLA countdown for a task, in whole minutes against scenario time (PRD F-2). */
export function slaRemainingMin(
  task: FlightProjection["tasks"][number],
  scenarioTs: string | null,
): number | null {
  if (!scenarioTs || task.state === "done") return null;
  return Math.max(0, minutesBetween(scenarioTs, task.plannedEnd));
}
