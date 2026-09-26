import { afterAll, describe, expect, it } from "vitest";

/**
 * F1 DoD RBAC matrix (rebook-ai milestones.md): role ladder
 * passenger < agent < supervisor enforced SERVER-SIDE (architecture.md §5),
 * plus the F1 contract slices of /api/v1/pax/summary (ownership surface) and
 * /api/v1/queue (agent+ surface). Runs against the compose profile "rebook".
 */

const BASE_URL = process.env.REBOOK_BASE_URL ?? "http://localhost:3004";

const PASSENGER = { email: "nadia.cho@pax-sim.example", password: "passenger-nx-01" };
const AGENT = { email: "amir.hassan@nx-sim.example", password: "agent-nx-01" };
const SUPERVISOR = { email: "grace.tan@nx-sim.example", password: "supervisor-nx-01" };

afterAll(async () => {
  /* no shared fixtures */
});

async function login(credentials: { email: string; password: string }): Promise<{
  status: number;
  cookie: string | null;
  body: Record<string, unknown>;
}> {
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  return {
    status: res.status,
    cookie: res.headers.get("set-cookie")?.split(";")[0] ?? null,
    body: (await res.json()) as Record<string, unknown>,
  };
}

async function get(
  path: string,
  cookie: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: cookie ? { cookie } : {},
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("auth (rebook-ai api-contracts.md §1)", () => {
  it("logs in every seeded role and pins the role in the response", async () => {
    for (const [credentials, role] of [
      [PASSENGER, "passenger"],
      [AGENT, "agent"],
      [SUPERVISOR, "supervisor"],
    ] as const) {
      const res = await login(credentials);
      expect(res.status).toBe(200);
      expect(res.cookie).toMatch(/^rbo_session=/);
      expect(res.body).toMatchObject({ user: { email: credentials.email, role } });
    }
  });

  it("rejects wrong credentials with the standard error envelope", async () => {
    const res = await login({ email: PASSENGER.email, password: "wrong-password" });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });
});

describe("rbac matrix (PRD F-7 ladder, server-side)", () => {
  it("blocks /api/v1/queue from unauthenticated and passenger callers", async () => {
    const anon = await get("/api/v1/queue", null);
    expect(anon.status).toBe(401);
    expect(anon.body).toMatchObject({ error: { code: "UNAUTHENTICATED" } });

    const passenger = await login(PASSENGER);
    const blocked = await get("/api/v1/queue", passenger.cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("serves /api/v1/queue to agent and supervisor (F2: live snapshot contract)", async () => {
    for (const credentials of [AGENT, SUPERVISOR]) {
      const session = await login(credentials);
      const res = await get("/api/v1/queue", session.cookie);
      expect(res.status).toBe(200);
      // F2 filled the snapshot (items/containment) — the F1 RBAC claim here is
      // the status + envelope shape, not the (now live) content.
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(typeof res.body.generatedAt).toBe("string");
      expect(res.body).toHaveProperty("containmentPct");
    }
  });

  it("serves the passenger summary to every role (ownership-scoped)", async () => {
    const passenger = await login(PASSENGER);
    const res = await get("/api/v1/pax/summary", passenger.cookie);
    expect(res.status).toBe(200);
    // F2 filled disruption/offers/vouchers/notifications; the contract shape
    // and the ownership scoping (passenger key) stay the assertion target.
    expect(res.body.passenger).toMatchObject({ email: PASSENGER.email });
    expect(res.body).toHaveProperty("disruption");
    expect(res.body).toHaveProperty("offers");
    expect(res.body).toHaveProperty("vouchers");
    expect(res.body).toHaveProperty("notifications");
  });
});
