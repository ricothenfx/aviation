import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Orchestrator HTTP surface (rebook-ai architecture.md §4/§7, engineering-
 * standards.md §5): /healthz liveness (never touches dependencies), /readyz
 * dependency readiness (503 when any named check fails) and /metrics in
 * Prometheus text format. Domain REST intentionally does NOT live here — the
 * browser never talks to the orchestrator; commands arrive via PostgreSQL +
 * the Redis control channel (ADR-0014 §2).
 */

/**
 * A check either throws (dependency down → 503, label "down") or resolves.
 * Resolving with a string overrides the "up" label — used for honest modes
 * like the LLM provider in `off (degrade)` configuration (ADR-0003/D-10),
 * which is a supported state, not an outage.
 */
export type HealthCheck = () => Promise<void | string>;

export interface MetricsSource {
  /** Monotonic counters rendered into /metrics (process lifetime). */
  counters: Record<string, number>;
}

export interface OrchestratorServerOptions {
  port: number;
  /** Named dependency checks for /readyz (e.g. postgres, redis, provider). */
  checks: Record<string, HealthCheck>;
  /** Extra metric lines appended under the orchestrator namespace. */
  metrics?: () => string[];
  onLog?: (msg: string, fields?: Record<string, unknown>) => void;
}

export function createOrchestratorServer(options: OrchestratorServerOptions): Server {
  const startedAt = Date.now();
  const counters: Record<string, number> = {
    rb_orchestrator_healthz_total: 0,
    rb_orchestrator_readyz_total: 0,
    rb_orchestrator_readyz_failures_total: 0,
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const respond = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/healthz") {
      counters["rb_orchestrator_healthz_total"] =
        (counters["rb_orchestrator_healthz_total"] ?? 0) + 1;
      respond(200, { status: "ok" });
      return;
    }
    if (req.url === "/readyz") {
      counters["rb_orchestrator_readyz_total"] =
        (counters["rb_orchestrator_readyz_total"] ?? 0) + 1;
      void (async () => {
        const dependencies: Record<string, string> = {};
        let failed = false;
        for (const [name, check] of Object.entries(options.checks)) {
          try {
            const label = await check();
            dependencies[name] = typeof label === "string" ? label : "up";
          } catch (err) {
            dependencies[name] = "down";
            failed = true;
            options.onLog?.("dependency_check_failed", {
              dependency: name,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (failed) {
          counters["rb_orchestrator_readyz_failures_total"] =
            (counters["rb_orchestrator_readyz_failures_total"] ?? 0) + 1;
        }
        respond(failed ? 503 : 200, {
          status: failed ? "unavailable" : "ready",
          dependencies,
        });
      })();
      return;
    }
    if (req.url === "/metrics") {
      const lines = [
        "# TYPE rb_orchestrator_uptime_seconds gauge",
        `rb_orchestrator_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`,
        ...Object.entries(counters).map(
          ([name, value]) => `# TYPE ${name} counter\n${name} ${value ?? 0}`,
        ),
        ...(options.metrics?.() ?? []),
      ];
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(lines.join("\n") + "\n");
      return;
    }
    respond(404, { error: "not_found" });
  });
  return server;
}

/**
 * Bind inside a container must be 0.0.0.0 for compose port publishing to reach
 * the service; host-side exposure stays restricted by the compose mapping
 * (127.0.0.1:hostPort→containerPort). Loopback-only in the topology contract
 * (rebook-ai architecture.md §8).
 */
export function listenOrchestratorServer(
  server: Server,
  port: number,
  host = "0.0.0.0",
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}
