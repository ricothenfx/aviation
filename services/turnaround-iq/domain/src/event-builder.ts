import type { DomainEvent, EventPayloadMap, EventType } from "@aviation/contracts";

import type { ReferenceDay } from "./reference-day";

/**
 * Deterministic event builder (architecture.md §3): given the reference day and a
 * scenario-time horizon, produce exactly the events whose scenario timestamp has
 * passed, honoring per-aggregate watermarks (ADR-0001 idempotency). Pure — the
 * same day + horizon + watermarks always yield byte-identical events.
 *
 * Only genuine state changes enter the log (turn.started, task.state_changed in F2;
 * alert and replan events join in F3 from their producers). kpi / scenario.tick /
 * delay_risk are wire-only derived frames, never logged.
 */

export type AggregateWatermarks = ReadonlyMap<string, number>;

const SCENARIO_TS_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/;

/** Truncate ISO strings to whole seconds so logs stay stable and readable. */
function wholeSecond(iso: string): string {
  const m = SCENARIO_TS_PATTERN.exec(iso);
  if (!m || !m[1]) throw new Error(`unexpected scenario timestamp: ${iso}`);
  return `${m[1]}Z`;
}

function buildEvent<K extends EventType>(args: {
  type: K;
  occurredAt: string;
  aggregateId: string;
  aggregateType: "flight" | "task";
  sequence: number;
  payload: EventPayloadMap[K];
}): DomainEvent & { type: K; payload: EventPayloadMap[K] } {
  return {
    id: `evt:${args.aggregateType}:${args.aggregateId}:${args.sequence}`,
    type: args.type,
    occurredAt: wholeSecond(args.occurredAt),
    aggregateId: args.aggregateId,
    aggregateType: args.aggregateType,
    sequence: args.sequence,
    payload: args.payload,
  };
}

/**
 * Events due at or before `upToScenarioMs`, skipping anything at or below the
 * caller's per-aggregate watermark. Sorted deterministically by
 * (occurredAt, aggregateId, sequence) so append order == replay order.
 */
export function buildEventsUpTo(
  day: ReferenceDay,
  upToScenarioMs: number,
  watermarks: AggregateWatermarks = new Map(),
): DomainEvent[] {
  const events: DomainEvent[] = [];
  const lastOf = (aggregateId: string): number => watermarks.get(aggregateId) ?? 0;

  for (const flight of day.flights) {
    const inBlockMs = Date.parse(flight.schedInBlock);
    if (inBlockMs <= upToScenarioMs && lastOf(flight.id) < 1) {
      events.push(
        buildEvent({
          type: "turn.started",
          occurredAt: flight.schedInBlock,
          aggregateId: flight.id,
          aggregateType: "flight",
          sequence: 1,
          payload: {
            flightId: flight.id,
            standCode: flight.standCode,
            scenarioTs: wholeSecond(flight.schedInBlock),
          },
        }),
      );
    }

    // Per-task sequences: 1 = in_progress at plannedStart, 2 = done at plannedEnd.
    for (const task of [...flight.tasks].sort((a, b) => a.order - b.order)) {
      const startMs = Date.parse(task.plannedStart);
      const endMs = Date.parse(task.plannedEnd);
      const wm = lastOf(task.id);
      if (startMs <= upToScenarioMs && wm < 1) {
        events.push(
          buildEvent({
            type: "task.state_changed",
            occurredAt: task.plannedStart,
            aggregateId: task.id,
            aggregateType: "task",
            sequence: 1,
            payload: {
              flightId: flight.id,
              taskId: task.id,
              state: "in_progress",
              scenarioTs: wholeSecond(task.plannedStart),
              slaRemainingMin: task.slaMinutes,
            },
          }),
        );
      }
      if (endMs <= upToScenarioMs && wm < 2) {
        events.push(
          buildEvent({
            type: "task.state_changed",
            occurredAt: task.plannedEnd,
            aggregateId: task.id,
            aggregateType: "task",
            sequence: 2,
            payload: {
              flightId: flight.id,
              taskId: task.id,
              state: "done",
              scenarioTs: wholeSecond(task.plannedEnd),
              slaRemainingMin: 0,
            },
          }),
        );
      }
    }
  }

  events.sort(
    (a, b) =>
      Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
      a.aggregateId.localeCompare(b.aggregateId) ||
      a.sequence - b.sequence,
  );
  return events;
}

/** Watermark name for an aggregate — the idempotency key half in event_log. */
export function aggregateWatermarkKey(aggregateId: string): string {
  return aggregateId;
}
