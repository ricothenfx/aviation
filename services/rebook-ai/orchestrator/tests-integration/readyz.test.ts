import { afterAll, describe, expect, it } from "vitest";

/**
 * F1 DoD: orchestrator readiness reports postgres, redis and provider status
 * (rebook-ai milestones.md), and /metrics renders Prometheus text format.
 * Runs against the compose profile "rebook" stack.
 */

const BASE_URL = process.env.RB_ORCHESTRATOR_URL ?? "http://localhost:4104";

afterAll(async () => {
  /* no shared fixtures */
});

describe("orchestrator readiness (ADR-0014 skeleton)", () => {
  it("reports db, redis and provider dependencies", async () => {
    const res = await fetch(`${BASE_URL}/readyz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      dependencies: Record<string, string>;
    };
    expect(body.status).toBe("ready");
    expect(body.dependencies.postgres).toBe("up");
    expect(body.dependencies.redis).toBe("up");
    // mock is the compose default; "off (degrade)" is the honest ADR-0003 mode.
    expect(body.dependencies.provider).toMatch(/^(up \(mock\)|off \(degrade\))$/);
  });

  it("renders Prometheus-format metrics", async () => {
    const res = await fetch(`${BASE_URL}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("rb_orchestrator_uptime_seconds");
    expect(text).toContain("rb_orchestrator_readyz_total");
  });

  it("exposes no domain REST surface (ADR-0014 §2)", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/queue`);
    expect(res.status).toBe(404);
  });
});
