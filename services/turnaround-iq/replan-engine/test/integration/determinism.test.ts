import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { events as eventsTable } from "@aviation/db/schema";
import type { AggregateType } from "@aviation/db/schema";
import type { DomainEvent } from "@aviation/contracts";
import {
  buildEventsUpTo,
  buildReferenceDay,
  canonicalBenchmarkFlight,
  buildRiskSnapshot,
  buildScheduleContext,
  evaluateRiskRules,
  planHash,
  planTasks,
} from "@aviation/tiq-domain";
import { buildTurnInput } from "../../src/snapshot";

import { openStack, type Stack } from "./helpers";

/**
 * F3 determinism DoD (milestones.md §F3): same seed + same log ⇒ identical plan
 * hash — asserted through the REAL snapshot builder (PG baseline + event-log
 * replay), not just the pure scheduler. The fixture log is the reference seed up
 * to the canonical inject instant plus the loader-breakdown blocked event.
 */

describe("replan determinism (same seed + log ⇒ identical plan hash)", () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await openStack();
    await stack.resetScenario();
  }, 30000);

  afterAll(async () => {
    await stack.resetScenario();
    await stack.close();
  }, 30000);

  it("builds byte-identical plan hashes from an identical log", async () => {
    const day = buildReferenceDay();
    const flight = canonicalBenchmarkFlight(day);
    const load = flight.tasks.find((task) => task.type === "baggage_load");
    if (!load) throw new Error("canonical flight has no baggage_load task");

    const nowMs = Date.parse(load.plannedStart) + 5 * 60_000;
    const seedEvents = buildEventsUpTo(day, nowMs);
    const blockedSequence = 2; // in_progress(1) already emitted for this task
    const blockedEvent: DomainEvent = {
      id: `evt:task:${load.id}:${blockedSequence}`,
      type: "task.state_changed",
      occurredAt: new Date(nowMs).toISOString(),
      aggregateId: load.id,
      aggregateType: "task",
      sequence: blockedSequence,
      payload: {
        flightId: flight.id,
        taskId: load.id,
        state: "blocked",
        scenarioTs: new Date(nowMs).toISOString(),
        slaRemainingMin: 49 + 9,
        blockedUntil: new Date(nowMs + 49 * 60_000).toISOString(),
      },
    };

    for (const event of [...seedEvents, blockedEvent]) {
      await stack.db
        .insert(eventsTable)
        .values({
          id: event.id,
          aggregateId: event.aggregateId,
          // Turnaround aggregate enum (rebook-ai's additive aggregates never
          // enter this event log, D-11/D-14).
          aggregateType: event.aggregateType as AggregateType,
          type: event.type,
          sequence: event.sequence,
          occurredAt: new Date(event.occurredAt),
          payload: event.payload,
          producer: "simulator",
        })
        .onConflictDoNothing();
    }

    const firstInput = await buildTurnInput(stack.db, flight.id);
    expect(firstInput).not.toBeNull();
    const secondInput = await buildTurnInput(stack.db, flight.id);

    const firstPlan = planTasks(buildScheduleContext(firstInput!));
    const secondPlan = planTasks(buildScheduleContext(secondInput!));
    expect(planHash(firstPlan)).toBe(planHash(secondPlan));
    // Same canonical numbers as the pure benchmark (replan-bench.test.ts).
    expect(firstPlan.baselineDelayMin).toBe(47);
    expect(firstPlan.totalDelayMin).toBeLessThanOrEqual(9);

    // The risk rules see the same picture from the same log.
    const findings = evaluateRiskRules(buildRiskSnapshot(firstInput!));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.leadTimeMin >= 10)).toBe(true);
  }, 60000);
});
