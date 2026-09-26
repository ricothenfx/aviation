import { sql } from "drizzle-orm";

import { LlmGateway } from "@aviation/llm-gateway";
import { createDb } from "@aviation/db/client";
import { createRedis } from "@aviation/db/redis";

/**
 * Service entrypoint (rebook-ai architecture.md §1–2, ADR-0014): F1 ships the
 * skeleton — dependencies, health/readiness/metrics surface and the LLM
 * provider wiring via `packages/llm-gateway` (ADR-0003). F2 adds the event-log
 * tail loop (offers/notifications/queue), F3 the propose-only agent loop and
 * the fulfillment saga executor. The browser never talks to this service;
 * commands arrive via PostgreSQL + the Redis control channel.
 */
import { createLogger } from "./logger";
import { createOrchestratorServer, listenOrchestratorServer } from "./server";

const logger = createLogger("rb-orchestrator");

const ORCHESTRATOR_PORT = Number(process.env.ORCHESTRATOR_PORT ?? 4104);

/**
 * rebook-ai database in the shared cluster (rebook-ai data-model.md, ADR-0015).
 * `@aviation/db`'s createDb resolves turnaround-iq's DATABASE_URL by default —
 * this service must never read it (mirrors the mro-copilot client isolation).
 */
const DEFAULT_REBOOK_DATABASE_URL = "postgresql://turnaround:turnaround@localhost:5433/rebook_ai";

async function main(): Promise<void> {
  const connectionString = process.env.REBOOK_DATABASE_URL ?? DEFAULT_REBOOK_DATABASE_URL;
  const { db, close: closeDb } = createDb(connectionString);
  const redis = await createRedis();

  // Provider wiring (ADR-0003): "mock" is the mandatory offline default;
  // "off" is a supported mode — the agent loop will degrade to rules and
  // label proposals `source: "rules"` (D-10). Readiness reflects it honestly.
  let gateway: LlmGateway | null = null;
  let providerMode = "off (degrade)";
  if ((process.env.LLM_PROVIDER ?? "mock") !== "off") {
    gateway = LlmGateway.fromEnv();
    providerMode = `up (${gateway.providerName})`;
  }

  const health = createOrchestratorServer({
    port: ORCHESTRATOR_PORT,
    onLog: (msg, fields) => logger.warn({ msg, ...fields }),
    checks: {
      postgres: async () => {
        await db.execute(sql`select 1`);
      },
      redis: async () => {
        await redis.redis.ping();
      },
      provider: async () => {
        if (!gateway) {
          // Supported mode, not an outage (ADR-0003/D-10): agent loop degrades
          // to rules and labels proposals `source: "rules"` — report honestly.
          return "off (degrade)";
        }
        // Deterministic ping: proves the provider completes, not just constructs.
        await gateway.complete({ messages: [{ role: "user", content: "provider ping" }] });
        return `up (${gateway.providerName})`;
      },
    },
  });
  await listenOrchestratorServer(health, ORCHESTRATOR_PORT);

  logger.info({
    msg: "rebook orchestrator ready",
    port: ORCHESTRATOR_PORT,
    provider: providerMode,
  });

  const shutdown = (signal: string): void => {
    logger.info({ msg: "shutting down", signal });
    health.close();
    void (async () => {
      await redis.close();
      await closeDb();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.error({
    msg: "rebook orchestrator crashed",
    err: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
