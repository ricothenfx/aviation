import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { alerts as alertsTable, events as eventsTable, replanScenarios } from "@aviation/db/schema";
import type { BoardSnapshot } from "@aviation/contracts";

import { openStack, SEED_USERS, type Stack } from "./helpers";

/**
 * F3 DoD (milestones.md §F3), end-to-end against the compose stack:
 * 1. RBAC matrix for the new alert/replan/inject endpoints (PRD F-7).
 * 2. Reference scenario: the risk alert leads the projected breach by ≥ 10 min.
 * 3. Loader-breakdown replan: propose → approve → board reflects the new
 *    schedule (planned windows shift via task.rescheduled projections).
 * 4. Infeasible case returns REPLAN_INFEASIBLE with the conflict list.
 */

const SPEED_20 = { speed: 20 as const };

async function getJson<T>(
  stack: Stack,
  path: string,
  cookie: string,
): Promise<{ status: number; body: T | null }> {
  const res = await fetch(`${stack.baseUrl}${path}`, { headers: { cookie } });
  const body = res.status === 204 ? null : ((await res.json().catch(() => null)) as T | null);
  return { status: res.status, body };
}

async function postJson<T>(
  stack: Stack,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<{ status: number; body: T | null }> {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = res.status === 204 ? null : ((await res.json().catch(() => null)) as T | null);
  return { status: res.status, body: parsed };
}

interface BoardFlight {
  id: string;
  flightNo: string;
  delayedMin: number;
  status: string;
  tasks: Array<{ id: string; type: string; state: string; plannedEnd: string }>;
}

async function board(stack: Stack, cookie: string): Promise<BoardSnapshot> {
  const res = await fetch(`${stack.baseUrl}/api/v1/board`, { headers: { cookie } });
  if (!res.ok) throw new Error(`board fetch failed: HTTP ${res.status}`);
  return (await res.json()) as BoardSnapshot;
}

async function waitFor<T>(timeoutMs: number, step: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await step();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

describe("F3 flow: alert → replan → approve → board (compose stack)", () => {
  let stack: Stack;
  let supervisor: string;
  let coordinator: string;
  let viewer: string;

  beforeAll(async () => {
    stack = await openStack();
    supervisor = await stack.cookieFor(SEED_USERS.supervisor.email, SEED_USERS.supervisor.password);
    coordinator = await stack.cookieFor(
      SEED_USERS.coordinator.email,
      SEED_USERS.coordinator.password,
    );
    viewer = await stack.cookieFor(SEED_USERS.viewer.email, SEED_USERS.viewer.password);
    await stack.resetScenario();
  }, 30000);

  afterAll(async () => {
    await stack.resetScenario();
    await stack.close();
  }, 30000);

  it("enforces the RBAC matrix server-side on every new endpoint (PRD F-7)", async () => {
    const fakeId = "11111111-1111-4111-8111-111111111111";

    // Viewer is denied everything above read.
    expect((await postJson(stack, `/api/v1/alerts/${fakeId}/acknowledge`, viewer)).status).toBe(
      403,
    );
    expect(
      (await postJson(stack, `/api/v1/alerts/${fakeId}/resolve`, viewer, { note: "x" })).status,
    ).toBe(403);
    expect((await postJson(stack, `/api/v1/flights/${fakeId}/replan`, viewer)).status).toBe(403);
    expect((await postJson(stack, `/api/v1/replans/${fakeId}/approve`, viewer)).status).toBe(403);
    expect(
      (
        await postJson(stack, "/api/v1/scenarios/reference-day/inject", viewer, {
          disruptionId: "loader-breakdown",
        })
      ).status,
    ).toBe(403);

    // Coordinator may act on alerts + replans but never drive scenarios.
    expect(
      (
        await postJson(stack, "/api/v1/scenarios/reference-day/inject", coordinator, {
          disruptionId: "loader-breakdown",
        })
      ).status,
    ).toBe(403);

    // Unknown disruption id fails validation even for the supervisor.
    expect(
      (
        await postJson(stack, "/api/v1/scenarios/reference-day/inject", supervisor, {
          disruptionId: "meteor",
        })
      ).status,
    ).toBe(400);
  }, 60000);

  it("raises the loader-breakdown alert ≥ 10 min ahead of the projected breach (PRD F-3)", async () => {
    await postJson(stack, "/api/v1/scenarios/reference-day/start", supervisor, SPEED_20);

    // Wait until the day is live enough for the script to find its target.
    await waitFor(480_000, async () => {
      const snapshot = await board(stack, supervisor);
      return snapshot.flights.some((flight) =>
        flight.tasks.some((task) => task.type === "baggage_load" && task.state === "in_progress"),
      )
        ? true
        : null;
    });

    const inject = await postJson<{ disruptionId: string; flightNo: string; status: string }>(
      stack,
      "/api/v1/scenarios/reference-day/inject",
      supervisor,
      { disruptionId: "loader-breakdown" },
    );
    expect(inject.status).toBe(200);
    expect(inject.body?.status).toBe("applied");
    const flightNo = inject.body?.flightNo as string;

    // Locate the injected flight + its load task from the board.
    const flight = await waitFor<BoardFlight>(30_000, async () => {
      const snapshot = await board(stack, supervisor);
      return snapshot.flights.find((candidate) => candidate.flightNo === flightNo) ?? null;
    });
    const load = flight.tasks.find((task) => task.type === "baggage_load");
    expect(flight.tasks.find((task) => task.type === "baggage_load")?.state).toBe("blocked");

    // The engine raises alert.raised as a real event_log event (ADR-0001).
    const alert = await waitFor<{
      id: string;
      severity: string;
      detail: { leadTimeMin: number | null };
    }>(60_000, async () => {
      const rows = await stack.db
        .select()
        .from(alertsTable)
        .where(eq(alertsTable.flightId, flight.id));
      const raised = rows.filter((row) => row.state === "raised" || row.state === "acknowledged");
      return raised.length > 0
        ? {
            id: raised[0]!.id,
            severity: raised[0]!.severity,
            detail: raised[0]!.detail as { leadTimeMin: number | null },
          }
        : null;
    });
    expect(alert.detail.leadTimeMin).not.toBeNull();
    // DoD: alert leads the breach by ≥ 10 minutes.
    expect(alert.detail.leadTimeMin as number).toBeGreaterThanOrEqual(10);

    // The breach is still a projection: the cause task has not finished yet —
    // for a blocked task the log holds in_progress(1) + blocked(2), done is 3.
    const loadEvents = await stack.db
      .select({ sequence: eventsTable.sequence })
      .from(eventsTable)
      .where(eq(eventsTable.aggregateId, load?.id as string));
    expect(loadEvents.length).toBeLessThan(3);
  }, 540_000);

  it("replans the loader breakdown: propose → approve → board reflects the plan (PRD F-4)", async () => {
    const flight = await waitFor<BoardFlight>(30_000, async () => {
      const snapshot = await board(stack, supervisor);
      return (
        snapshot.flights.find((candidate) =>
          candidate.tasks.some((task) => task.type === "baggage_load" && task.state === "blocked"),
        ) ?? null
      );
    });
    const pushbackBefore = flight.tasks.find((task) => task.type === "pushback");

    const proposed = await postJson<{
      replan: {
        id: string;
        totalDelayMin: number;
        baselineDelayMin: number;
        delta: Array<{ taskId: string }>;
        planHash: string;
      };
    }>(stack, `/api/v1/flights/${flight.id}/replan`, coordinator);
    expect(proposed.status).toBe(200);
    const replan = proposed.body?.replan;
    expect(replan).toBeDefined();
    // DoD math (in-progress inject): the do-nothing cascade measures exactly 47.
    expect(replan?.baselineDelayMin).toBe(47);
    // The live-path delay depends on how much scenario time passed between the
    // breakdown and the propose call (later call = larger managed slip — correct
    // engine behaviour). Assert the DoD bound with a ≥ 5 min improvement floor;
    // the strict 47 → ≤ 9 assertion is the deterministic benchmark's job
    // (replan-bench.test.ts + scripts/benchmarks/replan-delay.mjs).
    expect(replan?.totalDelayMin).toBeLessThanOrEqual(
      Math.max(9, (replan?.baselineDelayMin ?? 47) - 5),
    );
    expect(replan?.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(replan?.delta.length).toBeGreaterThan(0);

    // The gateway persists the proposal row from the event before approval reads it.
    await waitFor(15_000, async () => {
      const rows = await stack.db
        .select({ id: replanScenarios.id })
        .from(replanScenarios)
        .where(eq(replanScenarios.id, replan?.id as string));
      return rows.length > 0 ? true : null;
    });

    const approved = await postJson<{ status: string }>(
      stack,
      `/api/v1/replans/${replan?.id}/approve`,
      coordinator,
    );
    expect(approved.status).toBe(200);

    // Board reflects the new schedule: the pushback window moves to the plan.
    const moved = await waitFor<string | null>(120_000, async () => {
      const detail = await getJson<{ flight: BoardFlight }>(
        stack,
        `/api/v1/flights/${flight.id}`,
        supervisor,
      );
      const after = detail.body?.flight.tasks.find((task) => task.type === "pushback");
      return after && pushbackBefore && after.plannedEnd !== pushbackBefore.plannedEnd
        ? after.plannedEnd
        : null;
    });
    expect(moved).toBeTruthy();

    // Audit trail: the flight's event history carries the replan events.
    const events = await getJson<{ items: Array<{ type: string }> }>(
      stack,
      `/api/v1/flights/${flight.id}/events`,
      supervisor,
    );
    const types = events.body?.items.map((item) => item.type) ?? [];
    expect(types).toContain("replan.proposed");
    expect(types).toContain("replan.approved");
    expect(types).toContain("task.rescheduled");
  }, 180_000);

  it("returns REPLAN_INFEASIBLE with conflicts for the crew no-show (DoD)", async () => {
    // Wait for a turn the script can actually hit (cleaning not finished yet),
    // otherwise the simulator reports no_target and the injection is a no-op.
    await waitFor(480_000, async () => {
      const snapshot = await board(stack, supervisor);
      return snapshot.flights.some((candidate) =>
        candidate.tasks.some(
          (task) =>
            task.type === "cleaning" && (task.state === "pending" || task.state === "in_progress"),
        ),
      )
        ? true
        : null;
    });

    const inject = await postJson<{ status: string }>(
      stack,
      "/api/v1/scenarios/reference-day/inject",
      supervisor,
      { disruptionId: "crew-no-show" },
    );
    expect(inject.status).toBe(200);
    expect(inject.body?.status).toBe("applied");

    // Whichever turn the script hit ends up with a blocked cleaning task.
    const flight = await waitFor<BoardFlight>(30_000, async () => {
      const snapshot = await board(stack, supervisor);
      return (
        snapshot.flights.find((candidate) =>
          candidate.tasks.some((task) => task.type === "cleaning" && task.state === "blocked"),
        ) ?? null
      );
    });

    interface InfeasibleBody {
      error: { code: string; message: string; details: { conflicts: string[] } | undefined };
    }
    const response = await postJson<InfeasibleBody>(
      stack,
      `/api/v1/flights/${flight.id}/replan`,
      coordinator,
    );
    expect(response.status).toBe(422);
    expect(response.body?.error.code).toBe("REPLAN_INFEASIBLE");
    expect(response.body?.error.details?.conflicts.length ?? 0).toBeGreaterThan(0);
  }, 540_000);
});
