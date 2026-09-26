// Rebook-ai F2 DoD benchmark: queue live update after the event append,
// p95 < 1 s (milestones.md F2, PRD F-4). Subscribes to `chan:rb:live` (the
// frame fan-out the SSE bridge serves to browsers), injects disruptions as
// supervisor, and measures append → first queue.delta frame. Frame arrivals
// prove the projection was refreshed; the SSE bridge forwards the same frames.
//
// Usage: node scripts/benchmarks/rebook-queue-latency.mjs [--base http://localhost:3004] [--runs N]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = arg("--base", process.env.REBOOK_BASE_URL ?? "http://localhost:3004");
const REDIS_URL = arg("--redis", process.env.REDIS_URL ?? "redis://localhost:6379");
const RUNS = Number(arg("--runs", 20));

// `redis` resolves from packages/db's dependency graph (JS package — safe for
// require; the TS workspace sources stay behind @aviation/db's exports).
const dbRequire = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { createClient } = dbRequire("redis");

const fixtures = JSON.parse(
  readFileSync(new URL("../../apps/rebook-ai/seed/reference-day.json", import.meta.url), "utf8"),
);
const scheduled = fixtures.flights.map((f) => f.flightNo);

async function login(email, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: HTTP ${res.status}`);
  return res.headers.get("set-cookie").split(";")[0];
}

const supCookie = await login("grace.tan@nx-sim.example", "supervisor-nx-01");

const subscriber = createClient({ url: REDIS_URL });
await subscriber.connect();
const frames = [];
await subscriber.subscribe("chan:rb:live", (raw) => {
  try {
    const frame = JSON.parse(raw);
    if (frame.type === "queue.delta") frames.push({ receivedAt: Date.now(), frame });
  } catch {
    /* ignore non-frames */
  }
});

const results = [];
let run = 0;
for (const flightNo of scheduled) {
  if (results.length >= RUNS) break;
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/v1/scenario/inject`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: supCookie,
      "Idempotency-Key": `bench-queue-latency-${t0}`,
    },
    body: JSON.stringify({ scenario: "long-delay", flightNo }),
  });
  if (res.status !== 201) continue; // already disrupted / unknown — next flight
  const marker = frames.length;
  let latencyMs = null;
  while (Date.now() - t0 < 5_000) {
    const next = frames[marker];
    if (next) {
      latencyMs = next.receivedAt - t0;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (latencyMs === null) {
    console.error(`no queue.delta within 5 s for ${flightNo}`);
    continue;
  }
  results.push({ flightNo, latencyMs });
  run += 1;
  console.info(`${flightNo}: queue.delta in ${latencyMs} ms (run ${run})`);
}

await subscriber.quit();

if (results.length < 3) {
  console.error("too few successful iterations for a p95 — is the stack fresh?");
  process.exit(1);
}

const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
const p95 = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)];
const summary = {
  benchmark: "rebook-queue-latency",
  runs: results.length,
  minMs: latencies[0],
  medianMs: latencies[Math.floor(latencies.length / 2)],
  p95Ms: p95,
  maxMs: latencies[latencies.length - 1],
  gate: "p95 < 1000 ms",
  pass: p95 < 1_000,
};
console.info(JSON.stringify(summary, null, 2));
process.exit(summary.pass ? 0 : 1);
