import http from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { createDb } from "@aviation/db/client";
import { upsertReferenceDay } from "@aviation/db/baseline";
import { createRedis } from "@aviation/db/redis";
import type { DomainEvent } from "@aviation/contracts";
import {
  buildEventsUpTo,
  buildReferenceDay,
  CHAN_EVENTS,
  DAY_END_MS,
  emptyLogHash,
  uuidV5,
  type ReferenceDay,
  type ReferenceFlight,
} from "@aviation/tiq-domain";

/**
 * ×10 load-test event producer (milestones.md §F5, ADR-0007): replays the
 * deterministic reference day into N isolated replica banks so the ×10 scale
 * documented in data-model.md §4 (~15k events/scenario-day) becomes real
 * traffic. Phases:
 *
 *   prepare — delete previous LB-% replicas (cascade), upsert the replica
 *             baseline (flights + ground_tasks; projection tables stay
 *             replay-only, ADR-0001), then scenario reset via the supervisor
 *             REST endpoint so the gateway rebuilds its projection state from
 *             the enlarged baseline (the gateway only reads the baseline at
 *             boot/reset).
 *   run     — append + publish the replica events at a paced wall-clock rate,
 *             recording the durable-append instant of every event under its
 *             event id; k6 consumers correlate that instant with frame arrival
 *             to measure true ingestion→board latency.
 *
 * Replica ids are uuidV5-derived from the reference day, so runs are
 * deterministic and cleanup is a single `flight_no LIKE 'LB-%'` delete.
 * The producer never truncates the event log itself — scenario reset remains
 * an operator action behind the supervisor-only endpoint (event-log.ts).
 */

import { appendEvents } from "../event-log";
import { createLogger } from "../logger";

const logger = createLogger("load-producer");

const LOAD_REPLICAS = Number(process.env.LOAD_REPLICAS ?? 10);
const LOAD_RATE_PER_SEC = Number(process.env.LOAD_RATE_PER_SEC ?? 100);
const LOAD_START_DELAY_S = Number(process.env.LOAD_START_DELAY_S ?? 20);
const LOAD_PRODUCER_PORT = Number(process.env.LOAD_PRODUCER_PORT ?? 4710);
const LOAD_BATCH_SIZE = Number(process.env.LOAD_BATCH_SIZE ?? 25);
const TIQ_BASE_URL = process.env.TIQ_BASE_URL ?? "http://localhost:3001";
const LOAD_SUPERVISOR_EMAIL = process.env.LOAD_SUPERVISOR_EMAIL ?? "priya.nair@nx-sim.example";
const LOAD_SUPERVISOR_PASSWORD = process.env.LOAD_SUPERVISOR_PASSWORD ?? "supervisor-nx-01";
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? "tiq_session";

/** "LB" = load bank; distinct from the seeded NX/SV fictional brands. */
const REPLICA_FLIGHT_NO_PREFIX = "LB-";

interface LoadManifest {
  replicas: number;
  ratePerSecTarget: number;
  batch: number;
  flightsUpserted: number;
  tasksUpserted: number;
  totalEvents: number;
  appended: number;
  appendedPerSecActual: number | null;
  resetAt: string | null;
  appendStartedAt: string | null;
  appendFinishedAt: string | null;
  wallWindowMs: number | null;
}

const manifest: LoadManifest = {
  replicas: LOAD_REPLICAS,
  ratePerSecTarget: LOAD_RATE_PER_SEC,
  batch: LOAD_BATCH_SIZE,
  flightsUpserted: 0,
  tasksUpserted: 0,
  totalEvents: 0,
  appended: 0,
  appendedPerSecActual: null,
  resetAt: null,
  appendStartedAt: null,
  appendFinishedAt: null,
  wallWindowMs: null,
};

/** Durable-append wall-clock instants by event id (k6 correlation anchor). */
const appendTimes = new Map<string, number>();

/** Lifecycle phase surfaced via /healthz so the runner arms k6 at the right time. */
let phase: "preparing" | "resetting" | "armed" | "running" | "done" = "preparing";

/** Replica world: deterministic uuidV5 clones of the reference day. */
function buildReplicaDay(day: ReferenceDay, replica: number): ReferenceDay {
  const flightId = new Map<string, string>();
  const taskId = new Map<string, string>();
  for (const flight of day.flights) {
    flightId.set(flight.id, uuidV5(`load:r${replica}:${flight.id}`));
    for (const task of flight.tasks) {
      taskId.set(task.id, uuidV5(`load:r${replica}:${task.id}`));
    }
  }
  return {
    ...day,
    flights: day.flights.map((flight) => {
      const cloneId = flightId.get(flight.id);
      if (!cloneId) throw new Error(`unmapped flight ${flight.id}`);
      return {
        ...flight,
        id: cloneId,
        // Distinct from the NX/SV brands (data-ethics.md §2) and unique per
        // replica under the (flight_no, sched_in_block) key.
        flightNo: `${REPLICA_FLIGHT_NO_PREFIX}${flight.flightNo.replace(/^NX-/, "")}-${replica}`,
        tasks: flight.tasks.map((task) => {
          const cloneTaskId = taskId.get(task.id);
          if (!cloneTaskId) throw new Error(`unmapped task ${task.id}`);
          return { ...task, id: cloneTaskId, flightId: cloneId };
        }),
      };
    }),
    // Dependencies are planning metadata; the projection baseline carries none
    // (rebuild.ts passes `dependencies: []`) and the scheduler is not under
    // test here.
    dependencies: [],
  };
}

async function deleteReplicaBaseline(db: ReturnType<typeof createDb>["db"]): Promise<void> {
  // ground_tasks + task_dependencies cascade on flight delete (data-model.md §1).
  await db.execute(sql`delete from flights where flight_no like ${`${REPLICA_FLIGHT_NO_PREFIX}%`}`);
}

async function main(): Promise<void> {
  if (LOAD_REPLICAS < 1 || LOAD_RATE_PER_SEC < 1) {
    throw new Error("LOAD_REPLICAS and LOAD_RATE_PER_SEC must be >= 1");
  }
  const { db, close: closeDb } = createDb();
  const { redis, close: closeRedis } = await createRedis();
  const referenceDay = buildReferenceDay();

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${LOAD_PRODUCER_PORT}`);
    if (url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, phase }));
      return;
    }
    if (url.pathname === "/append-time") {
      const id = url.searchParams.get("id");
      const wallMs = id ? appendTimes.get(id) : undefined;
      if (id && wallMs !== undefined) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id, wallMs }));
      } else {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unknown event id" }));
      }
      return;
    }
    if (url.pathname === "/manifest") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(manifest));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  const shutdown = (signal: string): void => {
    logger.info({ msg: "shutting down", signal });
    void (async () => {
      server.close();
      await deleteReplicaBaseline(db);
      await closeRedis();
      await closeDb();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Bind FIRST: a stale producer on this port must fail the run loudly here,
  // not after minutes of prepare work (F5 run-3 lesson — orphaned producer).
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(LOAD_PRODUCER_PORT, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      logger.info({ msg: "load producer listening", port: address.port });
      resolve();
    });
  });

  // Phase 1 — prepare: clean slate for replicas, enlarged baseline, gateway
  // rebuild via the operator reset endpoint.
  await deleteReplicaBaseline(db);
  const replicaDays: ReferenceDay[] = [];
  const replicaFlights: ReferenceFlight[] = [];
  for (let replica = 1; replica <= LOAD_REPLICAS; replica += 1) {
    const clone = buildReplicaDay(referenceDay, replica);
    replicaDays.push(clone);
    replicaFlights.push(...clone.flights);
  }
  manifest.flightsUpserted = replicaFlights.length;
  manifest.tasksUpserted = replicaFlights.reduce((sum, flight) => sum + flight.tasks.length, 0);
  await upsertReferenceDay(db, {
    stands: [],
    aircraftTypes: [],
    flights: replicaFlights,
    dependencies: [],
  });
  logger.info({
    msg: "replica baseline upserted",
    flights: manifest.flightsUpserted,
    tasks: manifest.tasksUpserted,
  });

  phase = "resetting";
  const session = await fetch(`${TIQ_BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: LOAD_SUPERVISOR_EMAIL,
      password: LOAD_SUPERVISOR_PASSWORD,
    }),
  });
  if (!session.ok) throw new Error(`supervisor login failed: ${session.status}`);
  const { token } = (await session.json()) as { token: string };
  const cookieHeader = `${AUTH_COOKIE_NAME}=${token}`;

  manifest.resetAt = new Date().toISOString();
  const reset = await fetch(`${TIQ_BASE_URL}/api/v1/scenarios/reference-day/reset`, {
    method: "POST",
    headers: { cookie: cookieHeader },
  });
  if (!reset.ok) throw new Error(`scenario reset failed: ${reset.status}`);

  // Reset rebuilds the gateway projection (empty log) — wait for the idle hash.
  const idleDeadline = Date.now() + 90_000;
  for (;;) {
    const listResponse = await fetch(`${TIQ_BASE_URL}/api/v1/scenarios`, {
      headers: { cookie: cookieHeader },
    });
    if (!listResponse.ok) throw new Error(`scenario list failed: ${listResponse.status}`);
    const list = (await listResponse.json()) as {
      scenarios?: Array<{ id: string; state: { status: string; logHash: string | null } }>;
    };
    const state = list.scenarios?.find((entry) => entry.id === "reference-day")?.state;
    if (state && state.status === "idle" && state.logHash === emptyLogHash()) break;
    if (Date.now() > idleDeadline) throw new Error("scenario reset did not settle in time");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  logger.info({ msg: "scenario reset settled — gateway projection rebuilt at ×10 baseline" });

  // Phase 2 — the ×10 event log, deterministically built by the same pure
  // builder the simulator uses (event-builder.ts), interleaved across banks.
  phase = "armed";
  const events: DomainEvent[] = [];
  for (const clone of replicaDays) {
    events.push(...buildEventsUpTo(clone, DAY_END_MS));
  }
  events.sort(
    (a, b) =>
      Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
      a.aggregateId.localeCompare(b.aggregateId) ||
      a.sequence - b.sequence,
  );
  manifest.totalEvents = events.length;

  const publish = async (event: DomainEvent): Promise<void> => {
    await redis.publish(CHAN_EVENTS, JSON.stringify(event));
  };

  let appendChain: Promise<void> = Promise.resolve();
  const startAppending = async (): Promise<void> => {
    phase = "running";
    const startWall = performance.now();
    manifest.appendStartedAt = new Date().toISOString();
    const batchCount = Math.ceil(events.length / LOAD_BATCH_SIZE);
    for (let index = 0; index < batchCount; index += 1) {
      const batch = events.slice(index * LOAD_BATCH_SIZE, (index + 1) * LOAD_BATCH_SIZE);
      appendChain = appendChain.then(async () => {
        await appendEvents(db, batch);
        const wallMs = Date.now();
        for (const event of batch) appendTimes.set(event.id, wallMs);
        for (const event of batch) await publish(event);
        manifest.appended += batch.length;
      });
      const dueMs = startWall + ((index + 1) * LOAD_BATCH_SIZE * 1000) / LOAD_RATE_PER_SEC;
      const sleepMs = dueMs - performance.now();
      if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
    await appendChain;
    manifest.appendFinishedAt = new Date().toISOString();
    manifest.wallWindowMs = Math.round(performance.now() - startWall);
    manifest.appendedPerSecActual =
      manifest.wallWindowMs > 0
        ? Math.round((manifest.appended / manifest.wallWindowMs) * 1000 * 100) / 100
        : null;
    phase = "done";
    logger.info({
      msg: "×10 event replay complete",
      appended: manifest.appended,
      wallWindowMs: manifest.wallWindowMs,
      perSecActual: manifest.appendedPerSecActual,
    });
  };
  setTimeout(() => void startAppending(), LOAD_START_DELAY_S * 1000);

  logger.info({
    msg: "load producer armed — appends begin after the consumer ramp",
    port: LOAD_PRODUCER_PORT,
    startDelayS: LOAD_START_DELAY_S,
    totalEvents: manifest.totalEvents,
  });
}

main().catch((err: unknown) => {
  logger.error({
    msg: "load producer crashed",
    err: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
