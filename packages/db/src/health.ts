import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Shared /healthz + /readyz HTTP endpoints for long-running services
 * (architecture.md §7, engineering-standards.md §5): liveness never touches
 * dependencies; readiness fails (503) when any named check fails.
 */

export type HealthCheck = () => Promise<void>;

export interface HealthServerOptions {
  port: number;
  /** Named dependency checks for /readyz (e.g. postgres, redis). */
  checks: Record<string, HealthCheck>;
  onLog?: (msg: string, fields?: Record<string, unknown>) => void;
}

export function createHealthServer(options: HealthServerOptions): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const respond = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/healthz") {
      respond(200, { status: "ok" });
      return;
    }
    if (req.url === "/readyz") {
      void (async () => {
        const dependencies: Record<string, string> = {};
        let failed = false;
        for (const [name, check] of Object.entries(options.checks)) {
          try {
            await check();
            dependencies[name] = "up";
          } catch (err) {
            dependencies[name] = "down";
            failed = true;
            options.onLog?.("dependency_check_failed", {
              dependency: name,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
        respond(failed ? 503 : 200, {
          status: failed ? "unavailable" : "ready",
          dependencies,
        });
      })();
      return;
    }
    respond(404, { error: "not_found" });
  });
  return server;
}

/**
 * Bind inside a container must be 0.0.0.0 for compose port publishing to reach
 * the service; host-side exposure stays restricted by the compose mapping
 * (127.0.0.1:hostPort→containerPort). Direct host runs default here too — the
 * F5 deployment concern is the public binding, not the local one.
 */
export function listenHealthServer(server: Server, port: number, host = "0.0.0.0"): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}
