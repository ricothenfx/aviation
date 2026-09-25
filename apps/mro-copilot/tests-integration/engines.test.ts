import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

/**
 * F4 engine-health integration tests (DoD, PRD FR-16..FR-18,
 * api-contracts.md §1/§4). Run against the compose stack: score-fleet drives
 * the REAL ai-service predictor with the committed FD001 artifact over the
 * seeded fleet; the alert lifecycle reuses the F3 sign-off discipline
 * (server-side RBAC, strict lifecycle chain, 409 LIFECYCLE_CONFLICT,
 * append-only audit).
 *
 * Fleet fixtures (data-ethics §2, committed synthetic sample):
 *   NX-E201 healthy · NX-E202 crossing threshold (alert, leadCycles ≥ 5) ·
 *   NX-E203 insufficient history (latestRul: null → "—", never 0).
 */

const BASE_URL = process.env.MRO_BASE_URL ?? "http://localhost:3003";

const ENGINEER = { email: "siti.rahayu@mro-sim.example", password: "engineer-nx-01" };
const VIEWER = { email: "tom.ng@mro-sim.example", password: "viewer-nx-01" };

const pool = new Pool({
  connectionString:
    process.env.MRO_DATABASE_URL ?? "postgresql://turnaround:turnaround@localhost:5433/mro_copilot",
  max: 2,
});

afterAll(async () => {
  await pool.end();
});

async function login(account: { email: string; password: string }): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(account),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

function post(path: string, cookie: string, body?: unknown, idempotencyKey?: string) {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
}

async function scoreFleet(cookie: string, key?: string) {
  const res = await post("/api/v1/engines/score-fleet", cookie, {}, key ?? `score-${Date.now()}`);
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/v1/engines — RBAC + shape", () => {
  it("401 unauthenticated, 200 for viewer (read path is viewer+)", async () => {
    const unauth = await fetch(`${BASE_URL}/api/v1/engines`);
    expect(unauth.status).toBe(401);
    const body = (await unauth.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe("UNAUTHENTICATED");

    const viewer = await login(VIEWER);
    const res = await fetch(`${BASE_URL}/api/v1/engines`, { headers: { Cookie: viewer } });
    expect(res.status).toBe(200);
  });

  it("fleet snapshot carries provenance on every scored unit", async () => {
    const viewer = await login(VIEWER);
    const res = await fetch(`${BASE_URL}/api/v1/engines`, { headers: { Cookie: viewer } });
    const body = (await res.json()) as {
      units: Array<{
        unitId: string;
        latestRul: number | null;
        modelVersion: string | null;
        modelSha256: string | null;
        dataset: string;
      }>;
    };
    const byUnit = new Map(body.units.map((u) => [u.unitId, u]));
    expect(byUnit.has("NX-E201")).toBe(true);
    expect(byUnit.has("NX-E202")).toBe(true);
    expect(byUnit.has("NX-E203")).toBe(true);
    // Synthetic units are labeled honestly (data-ethics §2).
    expect(byUnit.get("NX-E203")!.dataset).toBe("synthetic-sample");
    // Provenance invariant: a RUL number always carries modelVersion + sha256.
    for (const unit of body.units) {
      if (unit.latestRul !== null) {
        expect(unit.modelVersion).toBeTruthy();
        expect(unit.modelSha256).toHaveLength(64);
      } else {
        expect(unit.modelVersion).toBeNull();
        expect(unit.modelSha256).toBeNull();
      }
    }
  });
});

describe("POST /api/v1/engines/score-fleet — RBAC + provenance + honesty", () => {
  it("viewer is 403 (engineer+)", async () => {
    const viewer = await login(VIEWER);
    const { res } = await scoreFleet(viewer);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("engineer scores the fleet; insufficient-history units get no RUL", async () => {
    const engineer = await login(ENGINEER);
    const { res, body } = await scoreFleet(engineer, `score-int-${Date.now()}`);
    expect(res.status).toBe(200);

    const results = body.results as Array<{
      unitId: string;
      rulCycles: number;
      modelVersion: string;
      modelSha256: string;
    }>;
    const insufficient = body.insufficientHistory as string[];
    const scoredUnits = new Set(results.map((r) => r.unitId));

    expect(scoredUnits.has("NX-E203")).toBe(false);
    expect(insufficient).toContain("NX-E203");

    // Provenance on every prediction (FR-16, api-contracts §4).
    for (const r of results) {
      expect(r.modelVersion).toBe(body.modelVersion);
      expect(r.modelSha256).toHaveLength(64);
      expect(r.rulCycles).toBeGreaterThanOrEqual(0);
    }

    // Idempotency-Key replay returns the same body without re-scoring.
    const key = `score-replay-${Date.now()}`;
    const first = await post("/api/v1/engines/score-fleet", engineer, {}, key);
    expect(first.status).toBe(200);
    const replay = await post("/api/v1/engines/score-fleet", engineer, {}, key);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  });

  it("honesty case: NX-E203 keeps latestRul null after scoring (D-15)", async () => {
    const engineer = await login(ENGINEER);
    await scoreFleet(engineer, `score-honesty-${Date.now()}`);
    const res = await fetch(`${BASE_URL}/api/v1/engines`, { headers: { Cookie: engineer } });
    const body = (await res.json()) as {
      units: Array<{ unitId: string; latestRul: number | null }>;
    };
    const unit = body.units.find((u) => u.unitId === "NX-E203")!;
    expect(unit.latestRul).toBeNull();
  });
});

describe("maintenance-window alerts (FR-18) — lifecycle + RBAC + audit", () => {
  it("fixture unit crossing threshold raises an alert with leadCycles ≥ 5", async () => {
    const engineer = await login(ENGINEER);
    await scoreFleet(engineer, `score-alert-${Date.now()}`);
    const res = await fetch(`${BASE_URL}/api/v1/engines/alerts`, {
      headers: { Cookie: engineer },
    });
    const body = (await res.json()) as {
      alerts: Array<{
        unitId: string;
        state: string;
        leadCycles: number;
        projectedRul: number;
        threshold: number;
        modelVersion: string;
        modelSha256: string;
      }>;
    };
    const alert = body.alerts.find((a) => a.unitId === "NX-E202" && a.state !== "resolved");
    expect(alert).toBeTruthy();
    expect(alert!.projectedRul).toBeLessThanOrEqual(alert!.threshold);
    expect(alert!.leadCycles).toBeGreaterThanOrEqual(5);
    expect(alert!.leadCycles).toBe(alert!.projectedRul);
    // Provenance on alerts (api-contracts §4: any RUL number carries it).
    expect(alert!.modelVersion).toBeTruthy();
    expect(alert!.modelSha256).toHaveLength(64);
  });

  it("viewer cannot acknowledge/resolve (403); engineer can — full lifecycle", async () => {
    const engineer = await login(ENGINEER);
    const viewer = await login(VIEWER);

    // Ensure an open alert exists for the fixture unit.
    await scoreFleet(engineer, `score-lifecycle-${Date.now()}`);
    const list = await fetch(`${BASE_URL}/api/v1/engines/alerts`, {
      headers: { Cookie: engineer },
    });
    const listBody = (await list.json()) as {
      alerts: Array<{ alertId: string; unitId: string; state: string }>;
    };
    const alert = listBody.alerts.find((a) => a.unitId === "NX-E202" && a.state === "raised");
    expect(alert).toBeTruthy();
    const id = alert!.alertId;

    // Viewer blocked server-side.
    const viewerAck = await post(`/api/v1/engines/alerts/${id}/acknowledge`, viewer);
    expect(viewerAck.status).toBe(403);

    // Engineer acknowledges.
    const ack = await post(`/api/v1/engines/alerts/${id}/acknowledge`, engineer);
    expect(ack.status).toBe(200);
    const ackBody = (await ack.json()) as { state: string; acknowledgedByName: string };
    expect(ackBody.state).toBe("acknowledged");
    expect(ackBody.acknowledgedByName).toBe("Siti Rahayu");

    // Double-ack is a lifecycle conflict.
    const ackAgain = await post(`/api/v1/engines/alerts/${id}/acknowledge`, engineer);
    expect(ackAgain.status).toBe(409);
    expect(((await ackAgain.json()) as { error: { code: string } }).error.code).toBe(
      "LIFECYCLE_CONFLICT",
    );

    // Resolve requires a note (400 without) and is engineer+.
    const resolveNoNote = await post(`/api/v1/engines/alerts/${id}/resolve`, engineer, {});
    expect(resolveNoNote.status).toBe(400);
    const resolveShort = await post(`/api/v1/engines/alerts/${id}/resolve`, engineer, {
      note: "x",
    });
    expect(resolveShort.status).toBe(400);

    const resolve = await post(`/api/v1/engines/alerts/${id}/resolve`, engineer, {
      note: "Removal scheduled inside the window after trend review.",
    });
    expect(resolve.status).toBe(200);
    const resolveBody = (await resolve.json()) as {
      state: string;
      resolveNote: string;
      resolvedByName: string;
    };
    expect(resolveBody.state).toBe("resolved");
    expect(resolveBody.resolveNote).toContain("window");
    expect(resolveBody.resolvedByName).toBe("Siti Rahayu");

    // Resolving again conflicts.
    const again = await post(`/api/v1/engines/alerts/${id}/resolve`, engineer, { note: "again" });
    expect(again.status).toBe(409);
  });

  it("resolve on a raised (unacknowledged) alert is a lifecycle conflict", async () => {
    const engineer = await login(ENGINEER);

    // Resolve a still-raised alert: acknowledge a fresh one first is NOT done —
    // find any alert whose state is 'raised' after a fresh scoring round.
    await scoreFleet(engineer, `score-strict-${Date.now()}`);
    const list = await fetch(`${BASE_URL}/api/v1/engines/alerts`, {
      headers: { Cookie: engineer },
    });
    const listBody = (await list.json()) as {
      alerts: Array<{ alertId: string; state: string }>;
    };
    const raised = listBody.alerts.find((a) => a.state === "raised");
    if (!raised) return; // all fixture alerts already acknowledged by prior tests
    const resolve = await post(`/api/v1/engines/alerts/${raised.alertId}/resolve`, engineer, {
      note: "skipping acknowledge must fail",
    });
    expect(resolve.status).toBe(409);
    expect(((await resolve.json()) as { error: { code: string } }).error.code).toBe(
      "LIFECYCLE_CONFLICT",
    );
  });

  it("alert lifecycle events are append-only audit rows", async () => {
    const { rows } = await pool.query(
      "select event_type, alert_id from audit_events where event_type like 'alert.%' order by sequence asc",
    );
    expect(rows.length).toBeGreaterThan(0);
    const types = rows.map((r: { event_type: string }) => r.event_type);
    expect(types).toContain("alert.raised");
    expect(types).toContain("alert.acknowledged");
    expect(types).toContain("alert.resolved");
    // Strictly ordered sequences (replayability, data-model.md §2).
    const { rows: seqRows } = await pool.query(
      "select sequence from audit_events order by sequence asc limit 50",
    );
    const seqs = seqRows.map((r: { sequence: string }) => Number(r.sequence));
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    const id = rows[0]!.alert_id as string;
    await expect(
      pool.query("update audit_events set payload = '{}' where alert_id = $1", [id]),
    ).rejects.toThrow(/append-only/);
  });
});

describe("GET /api/v1/engines/model — provenance endpoint", () => {
  it("viewer can read; response matches the committed artifact metrics gate", async () => {
    const viewer = await login(VIEWER);
    const res = await fetch(`${BASE_URL}/api/v1/engines/model`, {
      headers: { Cookie: viewer },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modelVersion: string;
      modelSha256: string;
      dataset: string;
      metrics: { rmse: number; nasaScore: number };
    };
    expect(body.modelSha256).toHaveLength(64);
    expect(body.dataset).toBe("fd001");
    // DoD gate, live from the serving artifact: FD001 test RMSE ≤ 24.
    expect(body.metrics.rmse).toBeLessThanOrEqual(24);
  });
});
