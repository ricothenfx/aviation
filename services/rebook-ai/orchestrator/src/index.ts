import { sql } from "drizzle-orm";

import { LlmGateway } from "@aviation/llm-gateway";
import { createRedis } from "@aviation/db/redis";

/**
 * Service entrypoint (rebook-ai architecture.md §1–2, ADR-0014). F2 wires the
 * domain engine: event-log tail (offers/notifications/vouchers/queue), the
 * offer expiry sweep, the SNS-shaped inbox publisher and the control channel
 * for the web app (queue rebuild). F3 adds the propose-only agent loop and
 * the fulfillment saga executor. The browser never talks to this service.
 */
import { createLogger } from "./logger";
import { createOrchestratorDb } from "./db";
import { createInboxNotificationPublisher } from "./domain/notifications";
import { createQueueProjector } from "./domain/queue";
import { expireOffers } from "./domain/handlers";
import { startControlListener } from "./engine/control";
import { startEventTail } from "./engine/tail";
import type { EngineMetrics } from "./domain/handlers";
import { createOrchestratorServer, listenOrchestratorServer } from "./server";

const logger = createLogger("rb-orchestrator");

const ORCHESTRATOR_PORT = Number(process.env.ORCHESTRATOR_PORT ?? 4104);
const POLL_MS = Number(process.env.RB_POLL_MS ?? 150);
const OFFER_SWEEP_MS = Number(process.env.RB_OFFER_SWEEP_MS ?? 20_000);

async function main(): Promise<void> {
  const { db, close: closeDb } = createOrchestratorDb();
  const redis = await createRedis();

  // Provider wiring (ADR-0003): "mock" is the mandatory offline default;
  // "off" is a supported mode — the F3 agent loop will degrade to rules and
  // label proposals `source: "rules"` (D-10). Readiness reflects it honestly.
  let gateway: LlmGateway | null = null;
  let providerMode = "off (degrade)";
  if ((process.env.LLM_PROVIDER ?? "mock") !== "off") {
    gateway = LlmGateway.fromEnv();
    providerMode = `up (${gateway.providerName})`;
  }

  const metrics: EngineMetrics = {
    counters: {
      rb_orchestrator_events_processed_total: 0,
      rb_orchestrator_event_failures_total: 0,
      rb_orchestrator_offers_created_total: 0,
      rb_orchestrator_vouchers_issued_total: 0,
      rb_orchestrator_notifications_sent_total: 0,
      rb_orchestrator_offers_expired_total: 0,
    },
  };
  const publisher = createInboxNotificationPublisher(db);
  const projector = createQueueProjector(db, redis.redis);

  const tail = startEventTail({
    db,
    redis: redis.redis,
    publisher,
    metrics,
    pollMs: POLL_MS,
    onLog: (msg, fields) => logger.info({ msg, ...fields }),
  });
  const control = startControlListener({
    redis: redis.redis,
    projector,
    onLog: (msg, fields) => logger.info({ msg, ...fields }),
  });

  // Offer expiry sweep (architecture.md §3.1): expired offers flip honestly to
  // `expired` with an offer.expired event — never silently confirmable.
  const sweep = setInterval(() => {
    void expireOffers({
      db,
      redis: redis.redis,
      publisher,
      metrics,
      onLog: (msg, fields) => logger.info({ msg, ...fields }),
    }).then((count) => {
      if (count > 0) {
        metrics.counters["rb_orchestrator_offers_expired_total"] =
          (metrics.counters["rb_orchestrator_offers_expired_total"] ?? 0) + count;
        logger.info({ msg: "offers_expired", count });
      }
    });
  }, OFFER_SWEEP_MS);

  const health = createOrchestratorServer({
    port: ORCHESTRATOR_PORT,
    onLog: (msg, fields) => logger.warn({ msg, ...fields }),
    metrics: () =>
      Object.entries(metrics.counters).map(
        (name_value) => `# TYPE ${name_value[0]} counter\n${name_value[0]} ${name_value[1] ?? 0}`,
      ),
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
    pollMs: POLL_MS,
    offerSweepMs: OFFER_SWEEP_MS,
  });

  const shutdown = (signal: string): void => {
    logger.info({ msg: "shutting down", signal });
    health.close();
    void (async () => {
      clearInterval(sweep);
      await tail.stop();
      await control.stop();
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
