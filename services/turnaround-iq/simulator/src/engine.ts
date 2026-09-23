import type { Db } from "@aviation/db/client";
import { upsertReferenceDay } from "@aviation/db/baseline";
import type { DomainEvent, ScenarioSpeed } from "@aviation/contracts";
import { taskRescheduledPayloadSchema } from "@aviation/contracts";
import {
  advanceScenarioClock,
  buildEventsUpTo,
  DAY_END_ISO,
  disruptionById,
  emptyLogHash,
  eventLogHash,
  initialScenarioState,
  planDisruptionAmendment,
  scenarioStartIso,
  selectInjectTarget,
  type InjectOutcome,
  type PlanOverride,
  type ReferenceDay,
  type ScenarioClockState,
} from "@aviation/tiq-domain";

import {
  appendEvents,
  loadWatermarks,
  readAllEvents,
  readEventsAfterSeq,
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
 *
 * F3: disruption injection (planDisruptionAmendment → blocked event + schedule
 * cascade overrides) and adoption of approved replans (task.rescheduled events
 * are polled from the log so the clock keeps emitting on the new schedule).
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
  overrides: ReadonlyMap<string, PlanOverride> = new Map(),
): { state: ScenarioClockState; events: DomainEvent[] } {
  const next = advanceScenarioClock(state, wallNowMs);
  if (next.status !== "running" || next.scenarioNow === null) {
    return { state: next, events: [] };
  }
  return {
    state: next,
    events: buildEventsUpTo(day, Date.parse(next.scenarioNow), watermarks, overrides),
  };
}

export class ScenarioEngine {
  private state: ScenarioClockState;
  private watermarks = new Map<string, number>();
  /** Amended planned windows (disruptions + approved replans), by task id. */
  private overrides = new Map<string, PlanOverride>();
  /** Log position up to which task.rescheduled events were adopted. */
  private lastSeenSeq = 0;
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
    // Re-adopt approved replans from the log (lastSeenSeq 0 ⇒ full sweep).
    this.lastSeenSeq = 0;
    await this.adoptReschedules();
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
   * full re-run is stable. Amendments and adopted replans reset with the log.
   */
  async reset(): Promise<void> {
    this.stop();
    this.overrides.clear();
    this.lastSeenSeq = 0;
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
    await this.adoptReschedules();
    const { state, events } = computeTick(
      this.day,
      this.state,
      Date.now(),
      this.watermarks,
      this.overrides,
    );
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

  /**
   * Disruption injection (api-contracts.md §1 POST /scenarios/{id}/inject,
   * milestones.md §F3). Deterministic target selection, then the unmanaged
   * cascade enters the log exactly like any operational event: a
   * task.state_changed {state:"blocked"} carrying the recovery constraint, and
   * amended planned windows for the affected + downstream tasks.
   */
  async inject(disruptionId: string, requestId: string): Promise<InjectOutcome> {
    const at = new Date().toISOString();
    const base: InjectOutcome = {
      requestId,
      disruptionId,
      status: "no_target",
      flightNo: null,
      at,
    };
    if (this.state.status !== "running" || this.state.scenarioNow === null) {
      await this.commit({ ...this.state, lastInject: base });
      return base;
    }
    const definition = disruptionById(disruptionId);
    if (!definition) {
      await this.commit({ ...this.state, lastInject: base });
      return base;
    }
    const scenarioNowMs = Date.parse(this.state.scenarioNow);
    const target = selectInjectTarget(this.day, definition, scenarioNowMs, (taskId) =>
      this.taskDone(taskId),
    );
    if (!target) {
      this.deps.logger.warn({ msg: "inject found no active turnaround", disruptionId });
      await this.commit({ ...this.state, lastInject: base });
      return base;
    }

    const amendment = planDisruptionAmendment(definition, scenarioNowMs, target, (taskId) =>
      this.taskDone(taskId),
    );

    // Blocked event (next sequence on the task aggregate) + plan overrides.
    const blockedTask = amendment.blocked.task;
    const sequence = (this.watermarks.get(blockedTask.id) ?? 0) + 1;
    const blockedEvent: DomainEvent = {
      id: `evt:task:${blockedTask.id}:${sequence}`,
      type: "task.state_changed",
      occurredAt: this.state.scenarioNow,
      aggregateId: blockedTask.id,
      aggregateType: "task",
      sequence,
      payload: {
        flightId: target.flight.id,
        taskId: blockedTask.id,
        state: "blocked",
        scenarioTs: this.state.scenarioNow,
        // recovery offset + remaining work — the scheduler/rule input (api-contracts.md §4)
        slaRemainingMin: amendment.blocked.slaRemainingMin,
        ...(amendment.blocked.blockedUntil ? { blockedUntil: amendment.blocked.blockedUntil } : {}),
        ...(amendment.blocked.standCurfew ? { standCurfew: amendment.blocked.standCurfew } : {}),
      },
    };
    const inserted = await appendEvents(this.deps.db, [blockedEvent]);
    if (inserted > 0) {
      await this.deps.publish(blockedEvent);
      this.watermarks.set(blockedTask.id, sequence);
    }

    for (const override of amendment.overrides) {
      this.overrides.set(override.taskId, {
        plannedStart: override.plannedStart,
        plannedEnd: override.plannedEnd,
      });
    }

    const applied: InjectOutcome = {
      requestId,
      disruptionId,
      status: "applied",
      flightNo: target.flight.flightNo,
      at,
    };
    await this.commit({ ...this.state, lastInject: applied });
    this.deps.logger.info({
      msg: "disruption injected",
      disruptionId,
      flightNo: applied.flightNo,
      scenarioNow: this.state.scenarioNow,
    });
    return applied;
  }

  /** Adopt approved replans: task.rescheduled events amend the running plan. */
  private async adoptReschedules(): Promise<void> {
    const batch = await readEventsAfterSeq(this.deps.db, this.lastSeenSeq, 200, "task.rescheduled");
    for (const event of batch) {
      this.lastSeenSeq = Math.max(this.lastSeenSeq, event.seq);
      const payload = taskRescheduledPayloadSchema.safeParse(event.payload);
      if (!payload.success) {
        this.deps.logger.warn({
          msg: "poison reschedule event rejected",
          eventId: event.id,
          err: payload.error.message,
        });
        continue;
      }
      this.overrides.set(payload.data.taskId, {
        plannedStart: payload.data.newStart,
        plannedEnd: payload.data.newEnd,
      });
      this.deps.logger.info({
        msg: "approved replan adopted",
        replanId: payload.data.replanId,
        taskId: payload.data.taskId,
      });
    }
  }

  /** Done-check against the engine's own watermark state (2 = done emitted). */
  private taskDone(taskId: string): boolean {
    return (this.watermarks.get(taskId) ?? 0) >= 2;
  }

  private async computeLogHash(): Promise<string> {
    return eventLogHash(await readAllEvents(this.deps.db));
  }
}
