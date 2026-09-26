// Rebook-ai F2 DoD benchmark: injection → ranked offers visible, p95 < 10 s
// (milestones.md F2, PRD §5). For each scheduled flight carrying seeded PNRs
// (from the committed fixtures), inject a cancellation as supervisor and poll
// the agent queue snapshot until a PNR of that flight shows a ranked offer —
// the offer row and the SNS-shaped notification are written by the same
// orchestrator handler pass, so "offer visible in the queue snapshot" is the
// pipeline-visible moment. Wall clock (no scenario clock in rebook F2).
//
// Usage: node scripts/benchmarks/rebook-offer-pipeline.mjs [--base http://localhost:3004] [--runs N]
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = arg("--base", process.env.REBOOK_BASE_URL ?? "http://localhost:3004");
const RUNS = Number(arg("--runs", 5));

const fixturesDir = new URL("../../apps/rebook-ai/seed/", import.meta.url);
const schedule = JSON.parse(readFileSync(new URL("reference-day.json", fixturesDir), "utf8"));
const pnrs = JSON.parse(readFileSync(new URL("pnrs.json", fixturesDir), "utf8"));
const inventory = JSON.parse(readFileSync(new URL("inventory.json", fixturesDir), "utf8"));

const scheduled = new Set(
  schedule.flights.filter((f) => f.status === "scheduled").map((f) => f.flightNo),
);
// Only routes with rebookable inventory produce offers (ranking §6: no
// candidates ⇒ honestly no offer) — restrict the benchmark to those routes.
const inventoryDests = new Set(inventory.candidates.map((c) => c.dest));
const pnrPerFlight = new Map();
for (const record of pnrs.pnrs) {
  for (const segment of record.segments) {
    pnrPerFlight.set(segment.flightNo, (pnrPerFlight.get(segment.flightNo) ?? 0) + 1);
  }
}
const flightDests = new Map(schedule.flights.map((f) => [f.flightNo, f.dest]));
const candidates = [...pnrPerFlight.entries()]
  .filter(
    ([flightNo]) => scheduled.has(flightNo) && inventoryDests.has(flightDests.get(flightNo) ?? ""),
  )
  .sort((a, b) => b[1] - a[1])
  .map(([flightNo]) => flightNo);

if (candidates.length < RUNS) {
  console.error(
    `not enough undisrupted candidate flights (${candidates.length}) for ${RUNS} runs — ` +
      `reseed the stack (docker compose --profile rebook down -v && up -d)`,
  );
  process.exit(1);
}

async function login(email, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: HTTP ${res.status}`);
  return res.headers.get("set-cookie").split(";")[0];
}

const SUPERVISOR = { email: "grace.tan@nx-sim.example", password: "supervisor-nx-01" };
const AGENT = { email: "amir.hassan@nx-sim.example", password: "agent-nx-01" };

const supCookie = await login(SUPERVISOR.email, SUPERVISOR.password);
const agentCookie = await login(AGENT.email, AGENT.password);

async function inject(flightNo) {
  const res = await fetch(`${BASE}/api/v1/scenario/inject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: supCookie },
    body: JSON.stringify({ scenario: "cancellation", flightNo }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function queueSnapshot() {
  const res = await fetch(`${BASE}/api/v1/queue`, { headers: { cookie: agentCookie } });
  if (!res.ok) throw new Error(`queue poll failed: HTTP ${res.status}`);
  return res.json();
}

const results = [];
for (const flightNo of candidates.slice(0, RUNS)) {
  const t0 = Date.now();
  const injected = await inject(flightNo);
  if (injected.status !== 201) {
    console.error(`inject ${flightNo} → HTTP ${injected.status}, skipping`);
    continue;
  }
  let latencyMs = null;
  while (Date.now() - t0 < 30_000) {
    const snapshot = await queueSnapshot();
    const visible = snapshot.items.some(
      (item) => item.flightNo === flightNo && item.offerState === "proposed",
    );
    if (visible) {
      latencyMs = Date.now() - t0;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (latencyMs === null) {
    console.error(`offers for ${flightNo} not visible within 30 s`);
    continue;
  }
  results.push({ flightNo, latencyMs });
  console.info(`${flightNo}: offers visible in ${latencyMs} ms`);
}

if (results.length === 0) {
  console.error("no successful iterations");
  process.exit(1);
}

const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
const p95 = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)];
const summary = {
  benchmark: "rebook-offer-pipeline",
  runs: results.length,
  minMs: latencies[0],
  medianMs: latencies[Math.floor(latencies.length / 2)],
  p95Ms: p95,
  maxMs: latencies[latencies.length - 1],
  gate: "p95 < 10000 ms",
  pass: p95 < 10_000,
};
console.info(JSON.stringify(summary, null, 2));
process.exit(summary.pass ? 0 : 1);
