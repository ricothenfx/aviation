import type { AlertSeverity } from "@aviation/contracts";

/**
 * Pure risk-rule evaluation (api-contracts.md §4: "Risk rule input: projection
 * snapshot {flight, tasks[], now, deps[]} → output {ruleId, severity,
 * projectedBreachTs, leadTimeMin, causeTaskId} | null"). No I/O, no clock, no
 * randomness: the same snapshot always yields the same findings — the
 * precondition for deterministic alert ids and audit-complete replay (ADR-0001).
 *
 * PRD F-3: flags projected SLA breaches ≥ 10 min ahead, e.g. "baggage load
 * blocked → departure at risk". leadTimeMin IS the acceptance measure
 * (milestones.md §F3: alert leads breach by ≥ 10 min).
 */

/** Minimum scenario minutes between the alert and the projected breach (PRD F-3). */
export const RISK_MIN_LEAD_MIN = 10;

/** Task types whose late finish holds the departure (dependency closure to pushback). */
const DEPARTURE_CRITICAL_TYPES = new Set([
  "baggage_load",
  "fueling",
  "boarding",
  "pushback",
  "cabin_check",
  "document_check",
]);

export type RiskTaskState = "pending" | "in_progress" | "done" | "blocked";

export interface RiskTask {
  id: string;
  type: string;
  state: RiskTaskState;
  plannedStart: string;
  plannedEnd: string;
  /**
   * Minutes of work left (done: 0; in_progress: planned remaining; blocked:
   * remaining work AFTER recovery).
   */
  remainingMin: number;
  /** Recovery instant while blocked — the outage is part of the projection. */
  blockedUntil: string | null;
}

export interface RiskSnapshot {
  flightId: string;
  flightNo: string;
  schedOffBlock: string;
  /** Scenario time the evaluation happens at (log-derived — never wall clock). */
  now: string;
  tasks: RiskTask[];
  dependencies: ReadonlyArray<{ taskId: string; predecessorTaskId: string }>;
}

export interface RiskFinding {
  ruleId: "sla.projected_breach" | "departure.at_risk";
  severity: AlertSeverity;
  flightId: string;
  causeTaskId: string;
  causeTaskType: string;
  projectedBreachTs: string;
  leadTimeMin: number;
  message: string;
}

interface EnrichedTask extends RiskTask {
  predecessors: string[];
}

const MIN = 60_000;

function minutes(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / MIN;
}

/** Deduplicate + topologically ordered projected finish times (api-contracts.md §4 deps[]). */
function projectedFinish(task: EnrichedTask, now: string, finishOf: Map<string, string>): string {
  if (task.state === "done") return task.plannedEnd;
  if (task.state === "in_progress" || task.state === "blocked") {
    const readyMs =
      task.state === "blocked" && task.blockedUntil
        ? Math.max(Date.parse(now), Date.parse(task.blockedUntil))
        : Date.parse(now);
    return new Date(readyMs + Math.max(0, task.remainingMin) * MIN).toISOString();
  }
  // pending: planned start, but never before every predecessor finishes.
  let startMs = Date.parse(task.plannedStart);
  for (const dep of task.predecessors) {
    const depFinish = finishOf.get(dep);
    if (depFinish) startMs = Math.max(startMs, Date.parse(depFinish));
  }
  const durationMin = Math.max(0, minutes(task.plannedStart, task.plannedEnd));
  return new Date(startMs + durationMin * MIN).toISOString();
}

/** Evaluate every rule; returns one finding per breach currently projectable. */
export function evaluateRiskRules(snapshot: RiskSnapshot): RiskFinding[] {
  const now = snapshot.now;
  const tasks: EnrichedTask[] = snapshot.tasks.map((task) => ({
    ...task,
    predecessors: snapshot.dependencies
      .filter((dep) => dep.taskId === task.id)
      .map((dep) => dep.predecessorTaskId),
  }));

  // Topological order (deps are acyclic by construction — data-model.md §2).
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const finishOf = new Map<string, string>();
  const permanent = new Set<string>();
  const visit = (task: EnrichedTask): void => {
    if (permanent.has(task.id)) return;
    for (const pred of task.predecessors) {
      const depTask = byId.get(pred);
      if (depTask) visit(depTask);
    }
    permanent.add(task.id);
    finishOf.set(task.id, projectedFinish(task, now, finishOf));
  };
  for (const task of tasks) visit(task);

  const findings: RiskFinding[] = [];

  // Rule 1 — task-level projected SLA breach (finishing after the planned end).
  for (const task of tasks) {
    if (task.state === "done") continue;
    const projectedEnd = finishOf.get(task.id);
    if (!projectedEnd) continue;
    const overrunMin = minutes(task.plannedEnd, projectedEnd);
    if (overrunMin <= 0) continue;
    const leadTimeMin = minutes(now, projectedEnd);
    if (leadTimeMin < RISK_MIN_LEAD_MIN) continue; // flag only ≥ 10 min ahead (PRD F-3)
    findings.push({
      ruleId: "sla.projected_breach",
      severity: "warning",
      flightId: snapshot.flightId,
      causeTaskId: task.id,
      causeTaskType: task.type,
      projectedBreachTs: projectedEnd,
      leadTimeMin: Math.round(leadTimeMin),
      message: `${task.type} on ${snapshot.flightNo} projected to finish ${Math.round(overrunMin)} min past its SLA`,
    });
  }

  // Rule 2 — departure at risk: projected off-block slips PAST THE CURRENT PLAN
  // (pushback plannedEnd). A flight that is *scheduled* to leave late (seed
  // delayedMin) is the plan, not a risk — alerting on it would cry wolf all
  // day; the board badge already shows planned delays.
  const pushback = tasks.find((task) => task.type === "pushback");
  if (pushback && pushback.state !== "done") {
    const projectedOffBlock = finishOf.get(pushback.id);
    if (projectedOffBlock) {
      const slipMin = minutes(pushback.plannedEnd, projectedOffBlock);
      if (slipMin > 0) {
        const leadTimeMin = minutes(now, projectedOffBlock);
        if (leadTimeMin >= RISK_MIN_LEAD_MIN) {
          // Cause = the open task with the largest projected overrun (deps first).
          let cause = pushback;
          let causeOverrun = -Infinity;
          for (const task of tasks) {
            if (task.state === "done") continue;
            if (!DEPARTURE_CRITICAL_TYPES.has(task.type) && task.id !== pushback.id) continue;
            const end = finishOf.get(task.id);
            if (!end) continue;
            const overrun = minutes(task.plannedEnd, end);
            if (overrun > causeOverrun) {
              causeOverrun = overrun;
              cause = task;
            }
          }
          findings.push({
            ruleId: "departure.at_risk",
            severity: "critical",
            flightId: snapshot.flightId,
            causeTaskId: cause.id,
            causeTaskType: cause.type,
            projectedBreachTs: projectedOffBlock,
            leadTimeMin: Math.round(leadTimeMin),
            message: `${snapshot.flightNo} departure at risk: +${Math.round(slipMin)} min beyond plan (cause: ${cause.type})`,
          });
        }
      }
    }
  }

  return findings;
}

/** Dedup key for an active alert — one open alert per (rule, cause task). */
export function riskAlertKey(finding: Pick<RiskFinding, "ruleId" | "causeTaskId">): string {
  return `${finding.ruleId}:${finding.causeTaskId}`;
}
