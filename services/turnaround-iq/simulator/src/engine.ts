import type { Db } from "@aviation/db/client";
import { upsertReferenceDay } from "@aviation/db/baseline";
import type { DomainEvent, ScenarioSpeed } from "@aviation/contracts";
import {
  advanceScenarioClock,
  buildEventsUpTo,
  DAY_END_ISO,
  emptyLogHash,
  eventLogHash,
  initialScenarioState,
  scenarioStartIso,
  type ReferenceDay,
  type ScenarioClockState,
} from "@aviation/tiq-domain";

import {
  appendEvents,
  loadWatermarks,
  readAllEvents,
  resetProjectionColumns,
  truncateEventLog,
} from "./event-log";
import type { Logger } from "./logger";

/**
 * The scenario engine (architecture.md §2–3): a wall-clock ticker advances the
 * scenario clock (× speed), derives due events deterministically, appends them to
 * the durable log (idempotent by aggregate + sequence) and publishes the events
 * that were actually inserted for the projection worker.
 *
 * Restart resume (architecture.md §6): events are durable in PostgreSQL; on boot
 * the engine rebuilds watermarks from the log and re-anchors the wall clock.
 */

export interface EngineDeps {
  db: Db;
  publish: (event: DomainEvent) => Promise<void>;
  logger: Logger;
  onStateChange: (state: ScenarioClockState) => Promise<void> | void;
  tickIntervalMs: number;
}

export interface TickResult {
  state: ScenarioClockState;
  built: number;
  inserted: number;
}

/** Pure computation: advance clock + build due events (unit-tested). */
export function computeTick(
  day: ReferenceDay,
  state: ScenarioClockState,
  wallNowMs: number,
  watermarks: ReadonlyMap<string, number>,
): { state: ScenarioClockState; events: DomainEvent[] } {
  const next = advanceScenarioClock(state, wallNowMs);
  if (next.status !== "running" || next.scenarioNow === null) {
    return { state: next, events: [] };
  }
  return { state: next, events: buildEventsUpTo(day, Date.parse(next.scenarioNow), watermarks) };
}

export class ScenarioEngine {
  private state: ScenarioClockState;
  private watermarks = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly day: ReferenceDay,
    private readonly deps: EngineDeps,
    state: ScenarioClockState = initialScenarioState("reference-day"),
  ) {
    this.state = state;
  }

  getState(): ScenarioClockState {
    return this.state;
  }

  /** Inject the persisted state at boot (Redis is the resting place of the clock). */
  setState(state: ScenarioClockState): void {
    this.state = state;
  }

  private async commit(next: ScenarioClockState): Promise<void> {
    this.state = next;
    await this.deps.onStateChange(next);
  }

  /** Boot: rebuild watermarks from the durable log; resume a crashed run. */
  async resync(): Promise<void> {
    this.watermarks = await loadWatermarks(this.deps.db);
    this.deps.logger.info({ msg: "watermarks resynced", aggregates: this.watermarks.size });
    if (this.state.status === "running") {
      const resumed: ScenarioClockState = {
        ...this.state,
        lastWallMs: Date.now(),
        scenarioNow: this.state.scenarioNow ?? scenarioStartIso(),
      };
      await this.commit(resumed);
      this.ensureTimer();
      this.deps.logger.info({ msg: "resumed running scenario", scenarioNow: resumed.scenarioNow });
    }
  }

  async start(speed: ScenarioSpeed): Promise<void> {
    this.stop();
    await upsertReferenceDay(this.deps.db, this.day);
    this.watermarks = await loadWatermarks(this.deps.db);
    await this.commit({
      ...this.state,
      status: "running",
      speed,
      scenarioNow: scenarioStartIso(),
      lastWallMs: Date.now(),
      logHash: this.watermarks.size === 0 ? emptyLogHash() : this.state.logHash,
    });
    this.ensureTimer();
    this.deps.logger.info({ msg: "scenario started", speed, scenarioNow: this.state.scenarioNow });
  }

  async setSpeed(speed: ScenarioSpeed): Promise<void> {
    await this.commit({ ...this.state, speed });
    this.ensureTimer();
    this.deps.logger.info({ msg: "scenario speed changed", speed });
  }

  /**
   * Reset (api-contracts.md §1): stop the clock, truncate the event log +
   * watermarks, replay the seed baseline, report the fresh (empty-log) hash.
   * PRD F-5: the same seed always replays byte-identically, so the hash after a
   * full re-run is stable.
   */
  async reset(): Promise<void> {
    this.stop();
    await truncateEventLog(this.deps.db);
    await resetProjectionColumns(this.deps.db);
    await upsertReferenceDay(this.deps.db, this.day);
    this.watermarks = await loadWatermarks(this.deps.db);
    await this.commit({ ...initialScenarioState(this.state.scenarioId), logHash: emptyLogHash() });
    this.deps.logger.info({ msg: "scenario reset", logHash: this.state.logHash });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runTick(), this.deps.tickIntervalMs);
  }

  async runTick(): Promise<TickResult> {
    const { state, events } = computeTick(this.day, this.state, Date.now(), this.watermarks);
    let inserted = 0;
    if (events.length > 0) {
      inserted = await appendEvents(this.deps.db, events);
      if (inserted > 0) {
        for (const event of events) {
          await this.deps.publish(event);
        }
        for (const event of events) {
          this.watermarks.set(
            event.aggregateId,
            Math.max(this.watermarks.get(event.aggregateId) ?? 0, event.sequence),
          );
        }
        this.deps.logger.info({
          msg: "events appended",
          count: inserted,
          eventId: events[0]?.id,
        });
      }
    }

    if (state.status === "completed" && this.state.status === "running") {
      const logHash = await this.computeLogHash();
      await this.commit({ ...state, logHash });
      this.stop();
      this.deps.logger.info({
        msg: "scenario completed",
        dayEnd: DAY_END_ISO,
        logHash,
      });
    } else if (state !== this.state) {
      await this.commit(state);
    }
    return { state: this.state, built: events.length, inserted };
  }

  private async computeLogHash(): Promise<string> {
    return eventLogHash(await readAllEvents(this.deps.db));
  }
}
