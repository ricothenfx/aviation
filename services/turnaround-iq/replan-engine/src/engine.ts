import type { Db } from "@aviation/db/client";
import type { RedisClientType } from "@aviation/db/redis";
import {
  alertLifecyclePayloadSchema,
  replanProposedPayloadSchema,
  taskRescheduledPayloadSchema,
  type DomainEvent,
  type ReplanProposedPayload,
} from "@aviation/contracts";
import {
  CHAN_EVENTS,
  buildRiskSnapshot,
  buildScheduleContext,
  evaluateRiskRules,
  planHash,
  planTasks,
  replanResultKey,
  uuidV5,
  type ReplanResult,
  type TurnPlanInput,
} from "@aviation/tiq-domain";

import { appendEvent, maxSeq, readEventsAfterSeq } from "./event-log";
import { buildTurnInput } from "./snapshot";
import type { Logger } from "./logger";

/**
 * Replan engine (architecture.md §2–3): tails the event log, evaluates the pure
 * risk rules on every relevant event and raises `alert.raised` as REAL events
 * (producer=replan_engine), computes replan proposals on control commands, and
 * applies approved plans by emitting `task.rescheduled` events the simulator
 * adopts. Decisions read PostgreSQL only — never Redis (architecture.md §2).
 */

export interface ReplanEngineDeps {
  db: Db;
  redis: RedisClientType;
  logger: Logger;
  pollIntervalMs: number;
}

interface ActiveAlert {
  alertId: string;
  flightId: string;
  causeTaskId: string;
  ruleId: string;
}

const RESULT_TTL_SECONDS = 120;

/** One open alert per (rule, cause task) — derivable from every payload. */
function alertDedupKey(ruleId: string, causeTaskId: string): string {
  return `${ruleId}:${causeTaskId}`;
}

export class ReplanEngine {
  private cursor = 0;
  private running = false;
  private polling = false;
  private timer: NodeJS.Timeout | null = null;
  /** Open alerts by dedup key (rule + cause task) — rebuilt from the log at boot. */
  private activeAlerts = new Map<string, ActiveAlert>();
  private alertKeyByAlertId = new Map<string, string>();
  /** Proposals seen in the log, ready for approval application. */
  private proposals = new Map<string, ReplanProposedPayload>();
  private appliedReplans = new Set<string>();

  constructor(private readonly deps: ReplanEngineDeps) {}

  /** Boot: replay the log to rebuild alert/replan state, then start tailing. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.replay();
    this.timer = setInterval(() => void this.poll(), this.deps.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Full replay: open alerts + proposals (crash recovery, architecture.md §6).
   * The cursor ends at the highest ABSORBED sequence — anything appended during
   * the replay is caught by the next tail poll, never skipped.
   */
  private async replay(): Promise<void> {
    const started = Date.now();
    this.activeAlerts.clear();
    this.alertKeyByAlertId.clear();
    this.proposals.clear();
    this.appliedReplans.clear();
    let after = 0;
    for (;;) {
      const batch = await readEventsAfterSeq(this.deps.db, after, 500);
      if (batch.length === 0) break;
      for (const event of batch) {
        after = event.seq;
        this.absorb(event);
      }
      if (batch.length < 500) break;
    }
    this.cursor = after;
    this.deps.logger.info({
      msg: "replan engine state rebuilt",
      events: after,
      activeAlerts: this.activeAlerts.size,
      proposals: this.proposals.size,
      cursor: this.cursor,
      ms: Date.now() - started,
    });
  }

  /** Track lifecycle state without re-raising history (alerts resume on next event). */
  private absorb(event: DomainEvent): void {
    if (event.type === "alert.raised") {
      const payload = alertLifecyclePayloadSchema.parse(event.payload);
      const key = alertDedupKey(payload.ruleId, payload.causeTaskId ?? payload.alertId);
      this.activeAlerts.set(key, {
        alertId: payload.alertId,
        flightId: payload.flightId,
        causeTaskId: payload.causeTaskId ?? "",
        ruleId: payload.ruleId,
      });
      this.alertKeyByAlertId.set(payload.alertId, key);
      return;
    }
    if (event.type === "alert.acknowledged" || event.type === "alert.resolved") {
      const payload = alertLifecyclePayloadSchema.parse(event.payload);
      const key = this.alertKeyByAlertId.get(payload.alertId);
      if (event.type === "alert.resolved" && key) {
        this.activeAlerts.delete(key);
        this.alertKeyByAlertId.delete(payload.alertId);
      }
      return;
    }
    if (event.type === "replan.proposed") {
      const payload = replanProposedPayloadSchema.parse(event.payload);
      this.proposals.set(payload.replanId, payload);
      return;
    }
    if (event.type === "replan.approved") {
      const payload = event.payload as { replanId: string };
      this.appliedReplans.add(payload.replanId);
    }
  }

  private async poll(): Promise<void> {
    if (!this.running || this.polling) return;
    this.polling = true;
    try {
      // Scenario resets TRUNCATE the log with RESTART IDENTITY — the log
      // position regresses below our cursor. Detect and rebuild from the fresh
      // log (the gateway projection worker does the same, ADR-0001 §replay).
      const current = await maxSeq(this.deps.db);
      if (current < this.cursor) {
        this.deps.logger.warn({
          msg: "event log regression detected — rebuilding engine state",
          cursor: this.cursor,
          maxSeq: current,
        });
        await this.replay();
        return;
      }
      const batch = await readEventsAfterSeq(this.deps.db, this.cursor, 200);
      for (const event of batch) {
        this.cursor = event.seq;
        await this.handle(event);
      }
    } catch (err) {
      this.deps.logger.error({
        msg: "replan engine poll failed",
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.polling = false;
    }
  }

  private async handle(event: DomainEvent): Promise<void> {
    switch (event.type) {
      case "task.state_changed": {
        const payload = event.payload as { flightId: string; taskId: string; state: string };
        await this.evaluateFlight(payload.flightId, event.occurredAt);
        if (payload.state === "done") {
          await this.resolveOnDone(payload.flightId, payload.taskId, event.occurredAt);
        }
        return;
      }
      case "task.rescheduled": {
        const payload = taskRescheduledPayloadSchema.parse(event.payload);
        await this.evaluateFlight(payload.flightId, event.occurredAt);
        return;
      }
      case "alert.acknowledged":
      case "alert.resolved": {
        const payload = alertLifecyclePayloadSchema.parse(event.payload);
        if (event.type === "alert.resolved") {
          const key = this.alertKeyByAlertId.get(payload.alertId);
          if (key) {
            this.activeAlerts.delete(key);
            this.alertKeyByAlertId.delete(payload.alertId);
          }
        }
        return;
      }
      case "replan.proposed": {
        const payload = replanProposedPayloadSchema.parse(event.payload);
        this.proposals.set(payload.replanId, payload);
        return;
      }
      case "replan.approved": {
        const payload = event.payload as { replanId: string; flightId: string };
        await this.applyApprovedPlan(payload.replanId, payload.flightId, event.occurredAt);
        return;
      }
      default:
        return;
    }
  }

  /** Evaluate both rules for one flight; raise deduped, deterministic alerts. */
  private async evaluateFlight(flightId: string, occurredAt: string): Promise<void> {
    const input = await buildTurnInput(this.deps.db, flightId);
    if (!input) return;
    const findings = evaluateRiskRules(buildRiskSnapshot(input));
    for (const finding of findings) {
      const key = alertDedupKey(finding.ruleId, finding.causeTaskId);
      if (this.activeAlerts.has(key)) continue;
      const alertId = uuidV5(
        `alert:${finding.flightId}:${finding.ruleId}:${finding.causeTaskId}:${occurredAt}`,
      );
      const raised = await appendEvent({
        db: this.deps.db,
        type: "alert.raised",
        aggregateId: alertId,
        aggregateType: "alert",
        occurredAt,
        payload: {
          alertId,
          flightId: finding.flightId,
          ruleId: finding.ruleId,
          severity: finding.severity,
          leadTimeMin: finding.leadTimeMin,
          causeTaskId: finding.causeTaskId,
        },
        producer: "replan_engine",
      });
      if (raised) {
        await this.publish(raised);
        this.activeAlerts.set(key, {
          alertId,
          flightId: finding.flightId,
          causeTaskId: finding.causeTaskId,
          ruleId: finding.ruleId,
        });
        this.alertKeyByAlertId.set(alertId, key);
        this.deps.logger.info({
          msg: "alert raised",
          alertId,
          ruleId: finding.ruleId,
          leadTimeMin: finding.leadTimeMin,
          flightId: finding.flightId,
        });
      }
    }
  }

  /**
   * Auto-resolve when work finishes: alerts blaming this task resolve; a
   * completed pushback (departure materialized) resolves everything the turn
   * still holds open.
   */
  private async resolveOnDone(flightId: string, taskId: string, occurredAt: string): Promise<void> {
    const isPushback = await this.taskTypeIs(flightId, taskId, "pushback");
    for (const [key, alert] of [...this.activeAlerts.entries()]) {
      if (alert.flightId !== flightId) continue;
      if (alert.causeTaskId !== taskId && !isPushback) continue;
      await this.resolveAlert(key, alert, occurredAt);
    }
  }

  private async taskTypeIs(flightId: string, taskId: string, type: string): Promise<boolean> {
    const input = await buildTurnInput(this.deps.db, flightId);
    const task = input?.planned.find((candidate) => candidate.id === taskId);
    return task?.type === type;
  }

  private async resolveAlert(key: string, alert: ActiveAlert, occurredAt: string): Promise<void> {
    const resolved = await appendEvent({
      db: this.deps.db,
      type: "alert.resolved",
      aggregateId: alert.alertId,
      aggregateType: "alert",
      occurredAt,
      payload: {
        alertId: alert.alertId,
        flightId: alert.flightId,
        ruleId: alert.ruleId,
        severity: "info",
        leadTimeMin: null,
      },
      producer: "replan_engine",
    });
    if (resolved) {
      await this.publish(resolved);
      this.activeAlerts.delete(key);
      this.alertKeyByAlertId.delete(alert.alertId);
    }
  }

  /** Control entrypoint: compute the plan, append replan.proposed, answer REST. */
  async propose(requestId: string, flightId: string): Promise<void> {
    let result: ReplanResult;
    const input = await buildTurnInput(this.deps.db, flightId);
    if (!input) {
      result = { ok: false, conflicts: ["flight_not_found"] };
    } else {
      result = await this.computeAndPropose(input);
    }
    await this.deps.redis.set(replanResultKey(requestId), JSON.stringify(result), {
      EX: RESULT_TTL_SECONDS,
    });
  }

  private async computeAndPropose(input: TurnPlanInput): Promise<ReplanResult> {
    const context = buildScheduleContext(input);
    const plan = planTasks(context);
    if (!plan.feasible) {
      return { ok: false, conflicts: plan.conflicts };
    }
    const hash = planHash(plan);
    const replanId = uuidV5(`replan:${input.flightId}:${input.now}:${hash}`);
    const delta = plan.assignments
      .map((assignment) => {
        const planned = input.planned.find((task) => task.id === assignment.taskId);
        return { assignment, planned };
      })
      .filter(
        ({ assignment, planned }) =>
          !planned ||
          assignment.newStart !== planned.plannedStart ||
          assignment.newEnd !== planned.plannedEnd,
      )
      .map(({ assignment }) => ({
        taskId: assignment.taskId,
        newStart: assignment.newStart,
        newEnd: assignment.newEnd,
      }));
    const proposed = await appendEvent({
      db: this.deps.db,
      type: "replan.proposed",
      aggregateId: replanId,
      aggregateType: "replan",
      occurredAt: input.now,
      payload: {
        replanId,
        flightId: input.flightId,
        delta,
        totalDelayMin: plan.totalDelayMin,
        baselineDelayMin: plan.baselineDelayMin,
        rationale: plan.rationale,
        planHash: hash,
      },
      producer: "replan_engine",
    });
    if (!proposed) {
      // Identical plan already proposed (same log ⇒ same id): idempotent re-read.
      const existing = this.proposals.get(replanId);
      if (existing) {
        return {
          ok: true,
          replanId,
          planHash: hash,
          totalDelayMin: existing.totalDelayMin,
          baselineDelayMin: existing.baselineDelayMin ?? existing.totalDelayMin,
          rationale: existing.rationale,
          delta: existing.delta,
        };
      }
      return { ok: false, conflicts: ["append_conflict"] };
    }
    await this.publish(proposed);
    const payload = proposed.payload as ReplanProposedPayload;
    this.proposals.set(replanId, payload);
    return {
      ok: true,
      replanId,
      planHash: hash,
      totalDelayMin: payload.totalDelayMin,
      baselineDelayMin: payload.baselineDelayMin ?? payload.totalDelayMin,
      rationale: payload.rationale,
      delta: payload.delta,
    };
  }

  /** Approval → task.rescheduled events per moved task (simulator adopts them). */
  private async applyApprovedPlan(
    replanId: string,
    flightId: string,
    occurredAt: string,
  ): Promise<void> {
    if (this.appliedReplans.has(replanId)) return;
    const proposal = this.proposals.get(replanId);
    if (!proposal) {
      this.deps.logger.warn({ msg: "approval for unknown proposal", replanId });
      return;
    }
    for (const item of proposal.delta) {
      const rescheduled = await appendEvent({
        db: this.deps.db,
        type: "task.rescheduled",
        aggregateId: item.taskId,
        aggregateType: "task",
        occurredAt,
        payload: {
          flightId,
          taskId: item.taskId,
          newStart: item.newStart,
          newEnd: item.newEnd,
          replanId,
        },
        producer: "replan_engine",
      });
      if (rescheduled) await this.publish(rescheduled);
    }
    this.appliedReplans.add(replanId);
    this.deps.logger.info({
      msg: "approved plan applied",
      replanId,
      moved: proposal.delta.length,
    });
  }

  private async publish(event: DomainEvent): Promise<void> {
    await this.deps.redis.publish(CHAN_EVENTS, JSON.stringify(event));
  }
}
