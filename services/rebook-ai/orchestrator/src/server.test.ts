import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createOrchestratorServer,
  listenOrchestratorServer,
  type OrchestratorServerOptions,
} from "./server";

/**
 * F1 DoD: /healthz liveness, /readyz dependency readiness (503 + named status)
 * and Prometheus-format /metrics — asserted over real HTTP against an
 * ephemeral port with injectable checks (engineering-standards.md §5).
 */

function fetchJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return fetch(`http://127.0.0.1:${port}${path}`).then(async (res) => ({
    status: res.status,
    body: (await res.json()) as unknown,
  }));
}

describe("orchestrator server", () => {
  const makeOptions = (checks: OrchestratorServerOptions["checks"]): OrchestratorServerOptions => ({
    port: 0,
    checks,
    metrics: () => ["# TYPE rb_test_gauge gauge", "rb_test_gauge 7"],
  });

  const servers: ReturnType<typeof createOrchestratorServer>[] = [];
  const ports: number[] = [];

  async function boot(options: OrchestratorServerOptions): Promise<number> {
    const server = createOrchestratorServer(options);
    servers.push(server);
    await listenOrchestratorServer(server, 0, "127.0.0.1");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no ephemeral port");
    const port = address.port;
    ports.push(port);
    return port;
  }

  beforeAll(() => {
    process.setMaxListeners(20);
  });

  afterAll(() => {
    for (const server of servers) server.close();
  });

  it("serves liveness without touching dependencies", async () => {
    const port = await boot(makeOptions({}));
    const res = await fetchJson(port, "/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("reports readiness per dependency and fails closed (503)", async () => {
    const up = makeOptions({
      postgres: async () => {},
      redis: async () => {},
      provider: async () => {},
    });
    const upPort = await boot(up);
    expect(await fetchJson(upPort, "/readyz")).toEqual({
      status: 200,
      body: { status: "ready", dependencies: { postgres: "up", redis: "up", provider: "up" } },
    });

    // Honest label override: LLM_PROVIDER=off is a supported degrade mode
    // (ADR-0003/D-10) — readiness stays green, the label says so.
    const degrade = makeOptions({
      provider: async () => "off (degrade)",
    });
    const degradePort = await boot(degrade);
    expect(await fetchJson(degradePort, "/readyz")).toEqual({
      status: 200,
      body: { status: "ready", dependencies: { provider: "off (degrade)" } },
    });

    let calls = 0;
    const down = makeOptions({
      postgres: async () => {
        calls += 1;
        throw new Error("connection refused");
      },
      redis: async () => {},
    });
    const downPort = await boot(down);
    const res = await fetchJson(downPort, "/readyz");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: "unavailable",
      dependencies: { postgres: "down", redis: "up" },
    });
    expect(calls).toBe(1);
  });

  it("renders Prometheus-format metrics with counters and custom lines", async () => {
    const port = await boot(makeOptions({}));
    await fetchJson(port, "/healthz");
    await fetchJson(port, "/readyz"); // empty checks all pass — readiness 200
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("rb_orchestrator_uptime_seconds");
    expect(text).toContain("rb_orchestrator_healthz_total 1");
    expect(text).toContain("rb_orchestrator_readyz_failures_total 0");
    expect(text).toContain("rb_test_gauge 7");
  });

  it("404s unknown paths (no domain REST on the orchestrator, ADR-0014 §2)", async () => {
    const port = await boot(makeOptions({}));
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/anything`);
    expect(res.status).toBe(404);
  });
});
