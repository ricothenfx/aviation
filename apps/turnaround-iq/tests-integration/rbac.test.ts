import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * RBAC matrix DoD (milestones.md §F2, PRD F-7): "Unauthorized actions blocked
 * server-side, not just hidden". Hits the running web app as all three seeded
 * roles plus unauthenticated. Requires the compose stack (TIQ_BASE_URL).
 */

const BASE = process.env.TIQ_BASE_URL ?? "http://localhost:3001";

interface Session {
  role: string;
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
  return { role: email.split(".")[0] ?? email, cookie: setCookie.split(";")[0] as string };
}

async function get(path: string, session: Session | null): Promise<number> {
  const res = await fetch(`${BASE}${path}`, {
    headers: session ? { cookie: session.cookie } : {},
  });
  return res.status;
}

async function post(path: string, session: Session | null, body?: unknown): Promise<number> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      ...(session ? { cookie: session.cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status;
}

describe("RBAC matrix (architecture.md §5, api-contracts.md §1)", () => {
  let viewer: Session;
  let coordinator: Session;
  let supervisor: Session;

  beforeAll(async () => {
    viewer = await login("arif.rahman@nx-sim.example", "viewer-nx-01");
    coordinator = await login("maya.tan@nx-sim.example", "coordinator-nx-01");
    supervisor = await login("priya.nair@nx-sim.example", "supervisor-nx-01");
  });

  afterAll(async () => {
    // Leave the stack in a clean state for subsequent suites.
    await post("/api/v1/scenarios/reference-day/reset", supervisor);
  });

  it("rejects unauthenticated access to reads and control", async () => {
    expect(await get("/api/v1/board", null)).toBe(401);
    expect(await get("/api/v1/scenarios", null)).toBe(401);
    expect(await post("/api/v1/auth/ws-token", null)).toBe(401);
  });

  it("viewer can read board/flights/events but not control scenarios", async () => {
    expect(await get("/api/v1/board", viewer)).toBe(200);
    expect(await get("/api/v1/events?after=0", viewer)).toBe(200);
    expect(await get("/api/v1/scenarios", viewer)).toBe(403);
    expect(await post("/api/v1/scenarios/reference-day/start", viewer, { speed: 5 })).toBe(403);
    expect(await post("/api/v1/scenarios/reference-day/reset", viewer)).toBe(403);
  });

  it("coordinator can read but not control scenarios (F3 mutations come later)", async () => {
    expect(await get("/api/v1/board", coordinator)).toBe(200);
    expect(await post("/api/v1/auth/ws-token", coordinator)).toBe(200);
    expect(await get("/api/v1/scenarios", coordinator)).toBe(403);
    expect(await post("/api/v1/scenarios/reference-day/start", coordinator, { speed: 5 })).toBe(
      403,
    );
  });

  it("supervisor controls scenarios end to end (start → status → reset)", async () => {
    expect(await get("/api/v1/scenarios", supervisor)).toBe(200);
    expect(await post("/api/v1/scenarios/reference-day/start", supervisor, { speed: 20 })).toBe(
      200,
    );
    const reset = await post("/api/v1/scenarios/reference-day/reset", supervisor);
    expect(reset).toBe(200);
  });

  it("rejects invalid scenario ids and malformed bodies with 404/400", async () => {
    expect(await post("/api/v1/scenarios/unknown-scenario/start", supervisor, { speed: 5 })).toBe(
      404,
    );
    expect(await post("/api/v1/scenarios/reference-day/start", supervisor, { speed: 7 })).toBe(400);
    expect(await get("/api/v1/flights/not-a-uuid", supervisor)).toBe(400);
    expect(await get("/api/v1/flights/7b3a1f29-1c5e-4a3f-9d2e-6f0f21fdba31", supervisor)).toBe(404);
  });
});
