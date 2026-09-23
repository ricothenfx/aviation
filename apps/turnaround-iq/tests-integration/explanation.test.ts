import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { replanExplanationSchema, scenarioListResponseSchema } from "@aviation/contracts";

/**
 * F4 DoD (milestones.md §F4, api-contracts.md §1): the copilot explanation
 * endpoint — coordinator+ RBAC (user decision 2026-09-23), contract-shaped
 * response, honest source label. Under the compose default the gateway runs
 * the mock provider, so the live label is "llm" with provider "mock"; the
 * rules-degraded label is pinned by src/lib/copilot/explain.test.ts.
 * Requires the compose stack (TIQ_BASE_URL).
 */

const BASE = process.env.TIQ_BASE_URL ?? "http://localhost:3001";

interface Session {
  cookie: string;
}

async function login(email: string, password: string): Promise<Session> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no session cookie returned");
  return { cookie: setCookie.split(";")[0] as string };
}

async function get(
  path: string,
  session: Session | null,
): Promise<{ status: number; body: unknown }> {
  // The dev server compiles routes on first hit and can drop sockets under
  // load (ECONNRESET) — retry briefly before treating it as a failure.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: session ? { cookie: session.cookie } : {},
      });
      const body = res.status === 204 ? null : await res.json().catch(() => null);
      return { status: res.status, body };
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("request failed");
}

async function post(
  path: string,
  session: Session | null,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: {
          ...(session ? { cookie: session.cookie } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const parsed = res.status === 204 ? null : await res.json().catch(() => null);
      return { status: res.status, body: parsed };
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("request failed");
}

describe("GET /api/v1/replans/{id}/explanation (F4, ADR-0003)", () => {
  let viewer: Session;
  let coordinator: Session;
  let supervisor: Session;

  beforeAll(async () => {
    viewer = await login("arif.rahman@nx-sim.example", "viewer-nx-01");
    coordinator = await login("maya.tan@nx-sim.example", "coordinator-nx-01");
    supervisor = await login("priya.nair@nx-sim.example", "supervisor-nx-01");
    await post("/api/v1/scenarios/reference-day/reset", supervisor);
  });

  afterAll(async () => {
    await post("/api/v1/scenarios/reference-day/reset", supervisor);
  });

  it("lists the disruption catalog for the scenario console (F4 additive contract)", async () => {
    const { status, body } = await get("/api/v1/scenarios", supervisor);
    expect(status).toBe(200);
    const parsed = scenarioListResponseSchema.parse(body);
    expect(parsed.disruptions.length).toBe(3);
    expect(parsed.disruptions.map((disruption) => disruption.id)).toEqual([
      "loader-breakdown",
      "gate-swap",
      "crew-no-show",
    ]);
  });

  it("blocks viewers and unauthenticated callers (coordinator+ RBAC)", async () => {
    const fakeId = "11111111-1111-4111-8111-111111111111";
    expect((await get(`/api/v1/replans/${fakeId}/explanation`, viewer)).status).toBe(403);
    expect((await get(`/api/v1/replans/${fakeId}/explanation`, null)).status).toBe(401);
  }, 30000);

  it("explains a real proposal with the honest source label", async () => {
    // Propose on a seeded turn (constraint engine answers even while idle).
    const board = await get("/api/v1/board", coordinator);
    expect(board.status).toBe(200);
    const flights = (board.body as { flights: Array<{ id: string }> }).flights ?? [];
    expect(flights.length).toBeGreaterThan(0);

    let replanId: string | null = null;
    for (const flight of flights.slice(0, 5)) {
      const proposed = await post(`/api/v1/flights/${flight.id}/replan`, coordinator);
      if (proposed.status === 200) {
        replanId = (proposed.body as { replan: { id: string } }).replan.id;
        break;
      }
    }
    expect(replanId).not.toBeNull();

    const { status, body } = await get(`/api/v1/replans/${replanId}/explanation`, coordinator);
    expect(status).toBe(200);
    const explanation = replanExplanationSchema.parse(body);
    expect(explanation.replanId).toBe(replanId);
    expect(explanation.source).toBe("llm");
    expect(explanation.provider).toBe("mock");
    expect(explanation.text.length).toBeGreaterThan(0);
  }, 120000);

  it("404s for an unknown replan id", async () => {
    const fakeId = "22222222-2222-4222-8222-222222222222";
    const { status, body } = await get(`/api/v1/replans/${fakeId}/explanation`, coordinator);
    expect(status).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  }, 30000);
});
