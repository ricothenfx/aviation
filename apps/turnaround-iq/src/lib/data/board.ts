import { asc, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@aviation/db/client";
import { flights, groundTasks, stands, aircraftTypes } from "@aviation/db/schema";
import {
  boardSnapshotSchema,
  type BoardSnapshot,
  type FlightProjection,
} from "@aviation/contracts";
import {
  KEY_PROJ_BOARD_INDEX,
  KEY_PROJ_BOARD_SUMMARY,
  KEY_SCENARIO_STATE,
  projFlightKey,
  type InjectOutcome,
  type ScenarioClockState,
} from "@aviation/tiq-domain";
import type { RedisClientType } from "@aviation/db/redis";

import { listActiveAlerts } from "@/lib/data/alerts";

/**
 * Board read path (api-contracts.md §1 GET /api/v1/board): live projections come
 * from Redis (data-model.md §3); when no scenario has run yet, the planned day is
 * served from the PostgreSQL seed baseline. WS is the primary transport — this
 * endpoint is the REST fallback + initial snapshot. F3 adds the active alerts
 * for the board rail (event-derived `alerts` projection rows).
 */

export async function readScenarioState(redis: RedisClientType): Promise<ScenarioClockState> {
  const raw = await redis.hGetAll(KEY_SCENARIO_STATE);
  if (!raw.scenarioId) {
    return {
      scenarioId: "reference-day",
      status: "idle",
      speed: 5,
      scenarioNow: null,
      lastWallMs: null,
      logHash: null,
      lastInject: null,
    };
  }
  return {
    scenarioId: raw.scenarioId,
    status: (raw.status as ScenarioClockState["status"]) ?? "idle",
    speed: (Number(raw.speed) || 5) as ScenarioClockState["speed"],
    scenarioNow: raw.scenarioNow || null,
    lastWallMs: raw.lastWallMs ? Number(raw.lastWallMs) : null,
    logHash: raw.logHash || null,
    lastInject: raw.lastInject ? (JSON.parse(raw.lastInject) as InjectOutcome) : null,
  };
}

export async function getBoardSnapshot(db: Db, redis: RedisClientType): Promise<BoardSnapshot> {
  const scenario = await readScenarioState(redis);
  const flightIds = await redis.sMembers(KEY_PROJ_BOARD_INDEX);

  let flightProjections: FlightProjection[] = [];
  if (flightIds.length > 0) {
    const hashes = await Promise.all(flightIds.map((id) => redis.hGetAll(projFlightKey(id))));
    flightProjections = hashes
      .map((hash) => parseProjection(hash.data))
      .filter((f): f is FlightProjection => f !== null);
  } else {
    flightProjections = await plannedBaseline(db);
  }
  flightProjections.sort(
    (a, b) =>
      Date.parse(a.schedInBlock) - Date.parse(b.schedInBlock) ||
      a.flightNo.localeCompare(b.flightNo),
  );

  const summaryRaw = await redis.hGetAll(KEY_PROJ_BOARD_SUMMARY);
  let kpis: BoardSnapshot["kpis"] = null;
  if (summaryRaw.kpis) {
    const parsed = z
      .object({
        onTimeDepPct: z.number(),
        avgTurnMin: z.number(),
        activeAlerts: z.number().int(),
        delayMinutesSaved: z.number(),
      })
      .safeParse(JSON.parse(summaryRaw.kpis));
    if (parsed.success) kpis = parsed.data;
  }

  const alerts = await listActiveAlerts(db);

  return boardSnapshotSchema.parse({
    generatedAt: new Date().toISOString(),
    scenarioTs: scenario.scenarioNow,
    live: scenario.status === "running",
    flights: flightProjections,
    kpis,
    alerts,
  });
}

function parseProjection(raw: string | undefined): FlightProjection | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FlightProjection;
  } catch {
    return null;
  }
}

/** Planned-day fallback: seed rows rendered as projections (status scheduled). */
export async function plannedBaseline(db: Db): Promise<FlightProjection[]> {
  const [flightRows, taskRows, standRows, typeRows] = await Promise.all([
    db.select().from(flights).orderBy(asc(flights.schedInBlock)),
    db.select().from(groundTasks),
    db.select().from(stands),
    db.select().from(aircraftTypes),
  ]);
  const standCodeById = new Map(standRows.map((s) => [s.id, s.code]));
  const typeCodeById = new Map(typeRows.map((t) => [t.id, t.code]));
  const tasksByFlight = new Map<string, typeof taskRows>();
  for (const task of taskRows) {
    const list = tasksByFlight.get(task.flightId);
    if (list) list.push(task);
    else tasksByFlight.set(task.flightId, [task]);
  }
  return flightRows.map((row) => {
    const tasks = (tasksByFlight.get(row.id) ?? []).map((task) => ({
      id: task.id,
      flightId: task.flightId,
      type: task.type,
      state: task.state,
      slaMinutes: task.slaMinutes,
      plannedStart: task.plannedStart.toISOString(),
      plannedEnd: task.plannedEnd.toISOString(),
    }));
    const pushback = tasks.find((t) => t.type === "pushback");
    const plannedOff = pushback?.plannedEnd ?? row.schedOffBlock.toISOString();
    const delayedMin = Math.max(
      0,
      Math.round((Date.parse(plannedOff) - Date.parse(row.schedOffBlock.toISOString())) / 60_000),
    );
    return {
      id: row.id,
      flightNo: row.flightNo,
      standId: row.standId,
      standCode: standCodeById.get(row.standId) ?? "?",
      aircraftTypeCode: typeCodeById.get(row.aircraftTypeId) ?? "?",
      schedInBlock: row.schedInBlock.toISOString(),
      schedOffBlock: row.schedOffBlock.toISOString(),
      estOffBlock: row.estOffBlock?.toISOString() ?? plannedOff,
      status: row.status,
      delayedMin,
      tasks,
    } satisfies FlightProjection;
  });
}

/** Single-flight projection: live from Redis, falling back to the planned row. */
export async function getFlightProjection(
  db: Db,
  redis: RedisClientType,
  flightId: string,
): Promise<FlightProjection | null> {
  const hash = await redis.hGetAll(projFlightKey(flightId));
  const live = parseProjection(hash.data);
  if (live) return live;
  const rows = await plannedBaseline(db);
  return rows.find((f) => f.id === flightId) ?? null;
}

/** Bulk fetch used by tests and the flight detail route. */
export async function flightExists(db: Db, flightId: string): Promise<boolean> {
  const rows = await db
    .select({ id: flights.id })
    .from(flights)
    .where(inArray(flights.id, [flightId]))
    .limit(1);
  return rows.length > 0;
}
