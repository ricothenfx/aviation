#!/usr/bin/env node
/**
 * rebook-ai load-run orchestrator (milestones.md §F5, ADR-0007 discipline —
 * structure mirrors run-mro-loadtest.mjs):
 *
 *   1. preflight the compose stack (web + orchestrator healthz/readyz),
 *   2. assert a FRESH stack (no disruptions, no offers, no replica banks),
 *   3. create the ×10 scale fixtures (deterministic replica banks,
 *      rebook-scale-fixtures.sql — load-run data, never committed fixtures),
 *   4. Phase A — k6 offer-pipeline wave at ×10 scale; gate: offers visible
 *      p95 < 10 s per flight (same visibility definition as the F2 benchmark),
 *   5. Phase B — k6 N-way confirm race (same-key + distinct-key groups),
 *   6. wait for every raced saga to reach a terminal state,
 *   7. verify exactly-one-effect in PostgreSQL (rebook-verify-effects.sql) —
 *      HTTP codes alone prove nothing,
 *   8. write verdict.json + k6 summaries + host-noise snapshots under
 *      scripts/loadtest/results/rebook/ and print the verdict.
 *
 * k6 runs from the binary when installed, else the grafana/k6 Docker image on
 * the host network (`--prom` remote-write is supported for the evidence
 * profile, ADR-0007 — not required for the gates).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const resultsDir = join(repoRoot, "scripts", "loadtest", "results", "rebook");

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};
const BANKS = Number(argVal("--banks", 10));
const RACERS = Number(argVal("--racers", 8));
const SAME_OFFERS = Number(argVal("--same-offers", 6));
const DISTINCT_OFFERS = Number(argVal("--distinct-offers", 6));
const OFFER_GATE_MS = Number(argVal("--offer-gate-ms", 10000));
const PHASE = args.find((a) => a.startsWith("--phase="))?.split("=")[1] ?? "all"; // all | offers | confirm
const prom = args.includes("--prom");

const BASE = process.env.REBOOK_BASE_URL ?? "http://localhost:3004";
const ORCHESTRATOR = process.env.REBOOK_ORCHESTRATOR_URL ?? "http://localhost:4104";
const POLLERS = Number(argVal("--pollers", 1));
const PACE_MS = Number(argVal("--pace-ms", 0));
const OFFER_LABEL = `×${BANKS} scale · ${POLLERS} console poller[s] · ${PACE_MS > 0 ? `paced ${PACE_MS} ms/flight` : "saturation burst"}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function psql(sql, extraVars = []) {
  const vars = extraVars.flatMap(([k, v]) => ["-v", `${k}=${v}`]);
  const probe = spawnSync("docker", ["info"], { encoding: "utf8" });
  const argv =
    probe.status === 0
      ? [
          "docker",
          "compose",
          "exec",
          "-T",
          "postgres",
          "psql",
          "-U",
          "turnaround",
          "-d",
          "rebook_ai",
          "-X",
          "-q",
          "-tA",
          "-v",
          "ON_ERROR_STOP=1",
          ...vars,
          "-f",
          "-",
        ]
      : [
          "sg",
          "docker",
          "-c",
          `docker compose exec -T postgres psql -U turnaround -d rebook_ai -X -q -tA -v ON_ERROR_STOP=1 ${vars
            .map((v, i) => (i % 2 === 1 ? `'${String(v).replaceAll("'", "'\\''")}'` : v))
            .join(" ")} -f -`,
        ];
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: repoRoot,
    input: sql,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`psql failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

function psqlScalar(sql, vars = []) {
  const out = psql(sql, vars).trim();
  const last = out.split("\n").filter(Boolean).pop();
  return last ?? "";
}

async function healthy(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

function quote(part) {
  return /\s/.test(part) ? `'${part.replaceAll("'", "'\\''")}'` : part;
}

function k6Available() {
  return spawnSync("k6", ["version"], { encoding: "utf8" }).status === 0;
}

function runK6(scenarioScript, summaryName, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  const passthrough = [
    "REBOOK_BASE_URL",
    "FLIGHTS",
    "POLLERS",
    "PACE_MS",
    "POLL_MS",
    "OFFER_TIMEOUT_MS",
    "TESTSET",
    "RACERS",
    "START_DELAY_MS",
  ];
  const envArgs = Object.entries(env)
    .filter(([key]) => passthrough.includes(key))
    .flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const outArgs = prom ? ["--out", "experimental-prometheus-rw"] : [];

  if (k6Available()) {
    const child = spawn(
      "k6",
      [
        "run",
        ...envArgs,
        "--summary-export",
        `scripts/loadtest/results/rebook/${summaryName}`,
        ...outArgs,
        `scripts/loadtest/${scenarioScript}`,
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );
    return new Promise((resolve) => child.on("exit", resolve));
  }

  const dockerArgs = [
    "run",
    "--rm",
    "--network",
    "host",
    "-v",
    `${repoRoot}:/repo`,
    "-w",
    "/repo",
    "-u",
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    ...envArgs,
    "grafana/k6:latest",
    "run",
    "--summary-export",
    `scripts/loadtest/results/rebook/${summaryName}`,
    ...outArgs,
    `scripts/loadtest/${scenarioScript}`,
  ];
  const probe = spawnSync("docker", ["info"], { encoding: "utf8" });
  const argv =
    probe.status === 0
      ? ["docker", ...dockerArgs]
      : ["sg", "docker", "-c", `docker ${dockerArgs.map(quote).join(" ")}`];
  const child = spawn(argv[0], argv.slice(1), { cwd: repoRoot, stdio: "inherit" });
  return new Promise((resolve) => child.on("exit", resolve));
}

function readSummary(name) {
  try {
    return JSON.parse(readFileSync(join(resultsDir, name), "utf8"));
  } catch {
    return null;
  }
}

function metricValues(summary, metric) {
  const m = summary?.metrics?.[metric];
  return m?.values ?? m ?? null;
}

function countOf(summary, metric) {
  const values = metricValues(summary, metric);
  return Number(values?.count ?? 0);
}

async function noiseSnapshot(label) {
  const loadavg = spawnSync("cat", ["/proc/loadavg"], { encoding: "utf8" }).stdout.trim();
  const stats = spawnSync(
    "docker",
    ["stats", "--no-stream", "--format", "{{.Name}} {{.CPUPerc}} {{.MemUsage}}"],
    { encoding: "utf8" },
  );
  writeFileSync(
    join(resultsDir, `host-noise-${label}.txt`),
    `# ${new Date().toISOString()} (${label})\nloadavg: ${loadavg}\n\n${stats.stdout}`,
  );
  console.info(
    `[runner] noise snapshot '${label}': load ${loadavg.split(" ").slice(0, 3).join(" ")}`,
  );
}

mkdirSync(resultsDir, { recursive: true });
for (const name of [
  "k6-offer-summary-saturation.json",
  "k6-offer-summary-paced.json",
  "k6-confirm-summary.json",
  "verdict.json",
  "effects-verification.txt",
]) {
  try {
    rmSync(join(resultsDir, name));
  } catch {
    /* absent — fine */
  }
}

// 1. Preflight ---------------------------------------------------------------
if (!(await healthy(`${BASE}/healthz`)) || !(await healthy(`${ORCHESTRATOR}/healthz`))) {
  console.error(
    `rebook stack is not healthy (web ${BASE}, orchestrator ${ORCHESTRATOR}) — start compose profile "rebook" first`,
  );
  process.exit(1);
}
const webReady = await fetch(`${BASE}/readyz`).then((r) => r.json());
const orchReady = await fetch(`${ORCHESTRATOR}/readyz`).then((r) => r.json());
if (webReady.status !== "ready" || orchReady.status !== "ready") {
  console.error(
    `readyz degraded: web=${JSON.stringify(webReady)} orch=${JSON.stringify(orchReady)}`,
  );
  process.exit(1);
}
console.info("[runner] stack healthy (web + orchestrator ready)");

// 2. Fresh-stack guard -------------------------------------------------------
const dirty = psqlScalar(
  `SELECT (SELECT count(*) FROM flights WHERE flight_no LIKE '%-R%')
        || '|' || (SELECT count(*) FROM offers)
        || '|' || (SELECT count(*) FROM flights WHERE status <> 'scheduled');`,
);
const [replicas, offerRows, disrupted] = dirty.split("|").map(Number);
if (replicas !== 0 || offerRows !== 0 || disrupted !== 0) {
  console.error(
    `stack is not fresh (replica flights=${replicas}, offers=${offerRows}, disrupted=${disrupted}) — ` +
      "rebook the demo stack: docker compose --profile rebook down -v && docker compose --profile rebook up -d --wait",
  );
  process.exit(1);
}
console.info("[runner] stack is fresh — proceeding");

if (!k6Available()) {
  console.info("[runner] no k6 binary — using the grafana/k6 docker image");
}

// 3. ×10 scale fixtures ------------------------------------------------------
if (PHASE === "all" || PHASE === "offers") {
  const fixturesSql = readFileSync(
    join(repoRoot, "scripts", "loadtest", "rebook-scale-fixtures.sql"),
    "utf8",
  );
  const summary = psql(fixturesSql, [["banks", String(BANKS)]]);
  console.info(summary.trim().split("\n").slice(-3).join("\n"));
}

const flightsCsv = psql(
  "SELECT string_agg(flight_no, ',' ORDER BY flight_no) FROM flights WHERE flight_no LIKE '%-R%';",
).trim();
const FLIGHTS = flightsCsv.split(",").filter(Boolean);
console.info(`[runner] ×${BANKS} wave: ${FLIGHTS.length} replica flights ready`);

await noiseSnapshot("before");

// 4. Phase A — offer pipeline wave -------------------------------------------
let offerGate = {
  gate: OFFER_GATE_MS,
  offer: OFFER_LABEL,
  k6P95: null,
  injectOk: null,
  visible: null,
  pass: false,
};
if (PHASE === "all" || PHASE === "offers") {
  const exit = await runK6(
    "rebook-offer-load.js",
    `k6-offer-summary${PACE_MS > 0 ? "-paced" : "-saturation"}.json`,
    {
      FLIGHTS: flightsCsv,
      POLLERS: String(POLLERS),
      PACE_MS: String(PACE_MS),
    },
  );
  console.info(`[runner] k6 offer wave (${OFFER_LABEL}) exited with ${exit}`);
  await noiseSnapshot("mid");

  const summaryName =
    PACE_MS > 0 ? "k6-offer-summary-paced.json" : "k6-offer-summary-saturation.json";
  const summary = readSummary(summaryName);
  const vis = metricValues(summary, "rebook_offer_visibility_ms");
  const inject = metricValues(summary, "rebook_inject_ok");
  const visible = metricValues(summary, "rebook_offers_visible");
  offerGate = {
    gate: OFFER_GATE_MS,
    offer: OFFER_LABEL,
    k6P95: vis?.["p(95)"] ?? null,
    injectOk: inject?.value ?? inject?.rate ?? null,
    visible: visible?.value ?? visible?.rate ?? null,
    pass:
      (vis?.["p(95)"] ?? Infinity) < OFFER_GATE_MS && (visible?.value ?? visible?.rate ?? 0) === 1,
  };
  console.info(
    `[runner] offer gate ${OFFER_LABEL}: p95=${offerGate.k6P95 ?? "n/a"}ms visible=${offerGate.visible} → ${offerGate.pass ? "PASS" : "FAIL"}`,
  );
}

// 5. Phase B — N-way confirm race --------------------------------------------
let effectVerdict = { pass: false, invariants: {}, testedOffers: 0 };
let phaseBCounts = null;
if (PHASE === "all" || PHASE === "confirm") {
  // Replica offers only (background bookings, bank-lettered locators), the
  // cheapest non-interline option each — DISTINCT ON guarantees one row per
  // offer so the same offer cannot land in both race groups.
  const rows = psql(
    `SELECT DISTINCT ON (o.id) o.id || ',' || oo.id
     FROM offers o
     JOIN pnr p ON p.id = o.pnr_id AND p.user_id IS NULL AND p.locator ~ '^[a-z]'
     JOIN offer_options oo ON oo.offer_id = o.id AND oo.interline = false
     WHERE o.state = 'proposed'
     ORDER BY o.id, oo.fare_delta, oo.rank;`,
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[0-9a-f-]{36},/.test(l));
  const pairs = [...new Set(rows)];
  if (pairs.length < SAME_OFFERS + DISTINCT_OFFERS) {
    console.error(
      `only ${pairs.length} rebookable replica offers — need ${SAME_OFFERS + DISTINCT_OFFERS}; ` +
        "was Phase A skipped or the stack dirty?",
    );
    process.exit(1);
  }
  const testset = [];
  for (let i = 0; i < SAME_OFFERS; i += 1) {
    const [offerId, optionId] = pairs[i].split(",");
    testset.push({ offerId, optionId, mode: "same" });
  }
  for (let i = 0; i < DISTINCT_OFFERS; i += 1) {
    const [offerId, optionId] = pairs[SAME_OFFERS + i].split(",");
    testset.push({ offerId, optionId, mode: "distinct" });
  }
  const testedIds = testset.map((t) => t.offerId).join(",");

  const exit = await runK6("rebook-confirm-load.js", "k6-confirm-summary.json", {
    TESTSET: JSON.stringify(testset),
    RACERS: String(RACERS),
  });
  console.info(`[runner] k6 confirm race exited with ${exit}`);
  await noiseSnapshot("after");

  // 6. Wait for every raced saga to reach a terminal state.
  const deadline = Date.now() + 120_000;
  let unfinished = -1;
  while (Date.now() < deadline) {
    unfinished = Number(
      psqlScalar(
        `SELECT count(*) FROM sagas
         WHERE offer_id::text = ANY (string_to_array(:'ids', ','))
           AND state IN ('running', 'failed');`,
        [["ids", testedIds]],
      ),
    );
    if (unfinished === 0) break;
    await sleep(1000);
  }
  console.info(`[runner] unfinished raced sagas after settle: ${unfinished}`);

  const summary = readSummary("k6-confirm-summary.json");
  phaseBCounts = {
    racers: RACERS,
    sameOffers: SAME_OFFERS,
    distinctOffers: DISTINCT_OFFERS,
    created: countOf(summary, "rebook_confirm_201"),
    conflict: countOf(summary, "rebook_confirm_409"),
    replayed: countOf(summary, "rebook_confirm_replayed"),
    serverErrors: countOf(summary, "rebook_confirm_5xx"),
    other: countOf(summary, "rebook_confirm_other"),
  };

  // 7. Exactly-one-effect verification in PostgreSQL.
  const verifySql = readFileSync(
    join(repoRoot, "scripts", "loadtest", "rebook-verify-effects.sql"),
    "utf8",
  );
  const raw = psql(verifySql, [["ids", testedIds]]);
  writeFileSync(join(resultsDir, "effects-verification.txt"), raw);
  const invariants = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([a-z_0-9]+)\|\s*(\d+)$/);
    if (m) invariants[m[1]] = Number(m[2]);
  }
  const violations = [
    "confirmations_gt1",
    "sagas_gt1",
    "payment_landed_ne1",
    "booking_issued_ne1",
    "payment_landed_zero",
    "sagas_not_completed",
    "audit_confirm_ne1",
  ];
  const effectChecks = {
    noEffectViolations: violations.every((k) => (invariants[k] ?? -1) === 0),
    testedOffers: invariants.test_offers ?? 0,
    everyEffectLandedOnce:
      invariants.test_offers === SAME_OFFERS + DISTINCT_OFFERS &&
      (invariants.payment_landed_zero ?? 1) === 0 &&
      (invariants.booking_issued_ne1 ?? 1) === 0,
    noServerErrors: phaseBCounts.serverErrors === 0 && phaseBCounts.other === 0,
    sameKeyReplayAll2xx:
      phaseBCounts.created === RACERS * SAME_OFFERS + DISTINCT_OFFERS &&
      phaseBCounts.replayed >= RACERS * SAME_OFFERS - SAME_OFFERS,
    distinctKeySingleWinner: phaseBCounts.conflict === DISTINCT_OFFERS * (RACERS - 1),
  };
  effectVerdict = {
    pass: Object.values(effectChecks).every(Boolean),
    checks: effectChecks,
    invariants,
    testedOffers: invariants.test_offers ?? 0,
  };
  console.info(
    `[runner] exactly-one-effect: ${JSON.stringify(effectChecks)} → ${effectVerdict.pass ? "PASS" : "FAIL"}`,
  );
}

await noiseSnapshot("after");

// 8. Verdict -----------------------------------------------------------------
const gates = [];
if (PHASE === "all" || PHASE === "offers") gates.push(["offerGate", offerGate.pass]);
if (PHASE === "all" || PHASE === "confirm") gates.push(["exactlyOneEffect", effectVerdict.pass]);
const passed = gates.length > 0 && gates.every(([, v]) => v);
writeFileSync(
  join(resultsDir, "verdict.json"),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      phase: PHASE,
      scale: { banks: BANKS, replicaFlights: FLIGHTS.length },
      offerGate,
      phaseB: { counts: phaseBCounts, effects: effectVerdict },
      gates: Object.fromEntries(gates),
      passed,
    },
    null,
    2,
  ),
);
console.info(`[runner] verdict → ${passed ? "PASS" : "FAIL"} (scripts/loadtest/results/rebook/)`);
if (!passed) process.exitCode = 1;
