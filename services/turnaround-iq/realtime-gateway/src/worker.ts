import type { Db } from "@aviation/db/client";
import type { RedisClientType } from "@aviation/db/redis";
import type { DomainEvent } from "@aviation/contracts";
import {
  applyRawEvent,
  CHAN_EVENTS,
  CHAN_SCENARIO_CONTROL,
  deriveKpis,
  KEY_PROJ_BOARD_INDEX,
  KEY_PROJ_BOARD_SUMMARY,
  KEY_SCENARIO_STATE,
  PROJECTION_KEY_PATTERN,
  projFlightKey,
  scenarioControlCommandSchema,
  type BoardProjectionState,
  type FlightProjection,
  type Kpis,
  type ScenarioClockState,
  type ScenarioControlCommand,
} from "@aviation/tiq-domain";

import {
  buildKpiFrame,
  buildTickFrame,
  framesForEvent,
  WS_CHANNEL_BOARD,
  wsChanFlight,
} from "./frames";
import { persistProjectionToPg } from "./pg-projections";
import type { Logger } from "./logger";
import {
  clearWatermarks,
  loadBaselineState,
  maxEventSeq,
  readEventsAfter,
  saveWatermarks,
} from "./rebuild";

/**
 * Projection worker (architecture.md §3 step 2): consumes new events idempotently
 * (per-aggregate `sequence` watermark + `applied_events` persistence), updates the
 * Redis read models and broadcasts ws delta frames. A PostgreSQL poll backstop
 * closes any pub/sub gap — the log remains the single source of truth.
 */

export interface WorkerDeps {
  db: Db;
  /** Command connection: projection writes + scenario-state reads. */
  redis: RedisClientType;
  /** Subscribe-only connection: Redis forbids commands while subscribed. */
  subscriber: RedisClientType;
  logger: Logger;
  broadcast: (channels: string[], frame: unknown) => void;
  pollIntervalMs: number;
}

export class ProjectionWorker {
  private state: BoardProjectionState | null = null;
  private watermarks = new Map<string, number>();
  /** Watermark entries not yet persisted to applied_events (drained by poll). */
  private dirtyWatermarks = new Map<string, number>();
  private pollCursor = 0;
  private lastKpis: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: WorkerDeps) {}

  /** Full rebuild = replay event_log over the PG baseline (ADR-0001 compliance). */
  async rebuild(): Promise<void> {
    const started = Date.now();
    const baseline = await loadBaselineState(this.deps.db);
    const log = await readEventsAfter(this.deps.db, 0, Number.MAX_SAFE_INTEGER);
    this.state = baseline;
    this.watermarks = new Map();
    for (const event of log) {
      this.applyOne(event);
    }
    this.pollCursor = await maxEventSeq(this.deps.db);
    await this.persistAll();
    this.deps.logger.info({
      msg: "projection rebuilt",
      events: log.length,
      flights: this.state.flights.size,
      ms: Date.now() - started,
    });
  }

  getState(): BoardProjectionState | null {
    return this.state;
  }

  /** Read-only access for tests/diagnostics: the live projection of one flight. */
  flightSnapshot(flightId: string): FlightProjection | null {
    return this.state?.flights.get(flightId) ?? null;
  }

  /** Test/ops hook: feed one raw event through the idempotent apply path. */
  async ingestRaw(raw: string): Promise<void> {
    await this.onPublishedEvent(raw);
  }

  /** Subscribe to the live feed + control channel; start the poll backstop. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.deps.subscriber.subscribe(CHAN_EVENTS, (raw) => {
      void this.onPublishedEvent(raw);
    });
    await this.deps.subscriber.subscribe(CHAN_SCENARIO_CONTROL, (raw) => {
      void this.onControl(raw);
    });
    this.pollTimer = setInterval(() => void this.poll(), this.deps.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Reset (scenario control): drop everything and rebuild from the empty log. */
  private async onControl(raw: string): Promise<void> {
    let command: ScenarioControlCommand;
    try {
      command = scenarioControlCommandSchema.parse(JSON.parse(raw));
    } catch {
      return;
    }
    if (command.action !== "reset") return;
    this.deps.logger.info({
      msg: "reset received — rebuilding projections",
      requestId: command.requestId,
    });
    this.stop();
    await this.deps.redis.del(KEY_PROJ_BOARD_INDEX);
    await this.deps.redis.del(KEY_PROJ_BOARD_SUMMARY);
    for (const key of await this.deps.redis.keys(PROJECTION_KEY_PATTERN)) {
      await this.deps.redis.del(key);
    }
    await clearWatermarks(this.deps.db);
    await this.rebuild();
    await this.start();
  }

  private async onPublishedEvent(raw: string): Promise<void> {
    let event: DomainEvent;
    try {
      event = JSON.parse(raw) as DomainEvent;
    } catch {
      this.deps.logger.warn({ msg: "dropping malformed published event" });
      return;
    }
    this.applyIfNew(event);
  }

  /** Poll backstop: durable catch-up for any pub/sub gap + watermark flush. */
  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      const batch = await readEventsAfter(this.deps.db, this.pollCursor, 500);
      for (const event of batch) {
        this.pollCursor = Math.max(this.pollCursor, event.seq);
        this.applyIfNew(event);
      }
      if (this.dirtyWatermarks.size > 0) {
        const pending = this.dirtyWatermarks;
        this.dirtyWatermarks = new Map();
        await saveWatermarks(this.deps.db, pending);
      }
    } catch (err) {
      this.deps.logger.error({
        msg: "projection poll failed",
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Idempotent apply: skip anything at or below the per-aggregate watermark. */
  private applyIfNew(event: DomainEvent): void {
    const watermark = this.watermarks.get(event.aggregateId) ?? 0;
    if (event.sequence <= watermark) {
      this.deps.logger.debug({
        msg: "duplicate event ignored",
        eventId: event.id,
        aggregateId: event.aggregateId,
        sequence: event.sequence,
      });
      return;
    }
    this.applyOne(event);
  }

  private applyOne(event: DomainEvent): void {
    if (!this.state) return;
    try {
      // Contract validation happens here: a poison event is logged loudly and
      // never applied (engineering-standards.md §6 — nothing dropped silently).
      applyRawEvent(this.state, event);
    } catch (err) {
      this.deps.logger.error({
        msg: "poison event rejected",
        eventId: event.id,
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.watermarks.set(event.aggregateId, event.sequence);
    this.dirtyWatermarks.set(event.aggregateId, event.sequence);

    const ts = new Date().toISOString();
    const frames = framesForEvent(event as DomainEvent & { payload: { flightId?: string } }, ts);
    // frames[0] is board-labeled, frames[1] flight-labeled (api-contracts.md §3).
    this.deps.broadcast([WS_CHANNEL_BOARD], frames[0]);
    if (frames[1]) this.deps.broadcast([wsChanFlight(taskFlightId(event))], frames[1]);

    void this.persistAffected(event.aggregateId, ts);
  }

  /** Persist the affected flight projection + derived KPIs to Redis and PG. */
  private async persistAffected(aggregateId: string, ts: string): Promise<void> {
    if (!this.state) return;
    const state = this.state;
    const flight =
      state.flights.get(aggregateId) ??
      [...state.flights.values()].find((f) => f.tasks.some((t) => t.id === aggregateId));
    if (flight) {
      await this.deps.redis.hSet(projFlightKey(flight.id), { data: JSON.stringify(flight) });
      await this.deps.redis.sAdd(KEY_PROJ_BOARD_INDEX, flight.id);
      // PG projection columns follow the same handler (data-model.md §2).
      try {
        await persistProjectionToPg(this.deps.db, flight);
      } catch (err) {
        this.deps.logger.error({
          msg: "pg projection update failed",
          flightId: flight.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const kpis: Kpis = state.kpis ?? deriveKpis(state);
    const serialized = JSON.stringify(kpis);
    if (serialized !== this.lastKpis) {
      this.lastKpis = serialized;
      await this.deps.redis.hSet(KEY_PROJ_BOARD_SUMMARY, {
        kpis: serialized,
        scenarioTs: state.scenarioTs ?? "",
        updatedAt: ts,
      });
      this.deps.broadcast([WS_CHANNEL_BOARD], buildKpiFrame(kpis, null, ts));
    }
  }

  /** Boot-time persistence of the full projection (cold Redis). */
  private async persistAll(): Promise<void> {
    if (!this.state) return;
    const state = this.state;
    const redis = this.deps.redis;
    await redis.del(KEY_PROJ_BOARD_INDEX);
    for (const flight of state.flights.values()) {
      await redis.hSet(projFlightKey(flight.id), { data: JSON.stringify(flight) });
      await redis.sAdd(KEY_PROJ_BOARD_INDEX, flight.id);
    }
    const kpis = state.kpis ?? deriveKpis(state);
    this.lastKpis = JSON.stringify(kpis);
    await redis.hSet(KEY_PROJ_BOARD_SUMMARY, {
      kpis: this.lastKpis,
      scenarioTs: state.scenarioTs ?? "",
      updatedAt: new Date().toISOString(),
    });
    await saveWatermarks(this.deps.db, this.watermarks);
  }

  /** Periodic scenario.tick frames from the simulator's clock (wire-only). */
  async broadcastTick(): Promise<void> {
    const scenario = await readScenarioState(this.deps.redis);
    if (scenario.status !== "running" || scenario.scenarioNow === null) return;
    this.deps.broadcast(
      [WS_CHANNEL_BOARD],
      buildTickFrame(scenario.scenarioNow, scenario.speed, new Date().toISOString()),
    );
  }
}

/** Read the simulator's clock mirror (same hash layout as the simulator writes). */
async function readScenarioState(redis: RedisClientType): Promise<ScenarioClockState> {
  const raw = await redis.hGetAll(KEY_SCENARIO_STATE);
  if (!raw.scenarioId) {
    return {
      scenarioId: "reference-day",
      status: "idle",
      speed: 5,
      scenarioNow: null,
      lastWallMs: null,
      logHash: null,
    };
  }
  return {
    scenarioId: raw.scenarioId,
    status: (raw.status as ScenarioClockState["status"]) ?? "idle",
    speed: (Number(raw.speed) || 5) as ScenarioClockState["speed"],
    scenarioNow: raw.scenarioNow || null,
    lastWallMs: raw.lastWallMs ? Number(raw.lastWallMs) : null,
    logHash: raw.logHash || null,
  };
}

/** Flight id out of a task aggregate event payload (api-contracts.md §3). */
function taskFlightId(event: DomainEvent): string {
  const payload = event.payload as { flightId?: string };
  return payload.flightId ?? event.aggregateId;
}
