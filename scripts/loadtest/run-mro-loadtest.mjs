#!/usr/bin/env node
/**
 * mro-copilot load-run orchestrator (milestones.md §F5, ADR-0007 discipline):
 *   1. preflight the compose stack (web healthz + app readyz with model up),
 *   2. start the independent single-client latency probe (search + ask),
 *   3. run the two k6 scenarios SEQUENTIALLY — search (100 VU, gate p95
 *      < 300 ms) then ask (25 VU, mock provider, gate p95 < 2.5 s) — so the
 *      gates are measured against isolated load, not a mixed offer,
 *   4. persist summaries + probe result under scripts/loadtest/results/mro/
 *      and print the verdict (gate must hold on BOTH the k6 trend and the
 *      probe — the tiq F5 lesson: generator self-starvation can skew k6's
 *      in-process trend on small hosts).
 *
 * k6 runs from the binary when installed, else the grafana/k6 Docker image
 * on the host network. `--prom` additionally remote-writes k6 metrics to the
 * evidence Prometheus (compose profile `evidence`, ADR-0007) — the evidence
 * profile is EPHEMERAL and never part of the demo stack.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const resultsDir = join(repoRoot, "scripts", "loadtest", "results", "mro");

const args = process.argv.slice(2);
const prom = args.includes("--prom");
const DURATION = args.find((arg) => arg.startsWith("--duration="))?.split("=")[1] ?? "120s";
const SEARCH_VUS = Number(args.find((a) => a.startsWith("--search-vus="))?.split("=")[1] ?? 100);
const ASK_VUS = Number(args.find((a) => a.startsWith("--ask-vus="))?.split("=")[1] ?? 25);
/** Think time (ms) between iterations per VU. 0 = closed-loop saturation
 * offer; paced offers (e.g. 4000 ms) model concurrent users and make the
 * gates per-request latency claims. The offer is recorded in verdict.json —
 * gates are only compared within the same offer (honest reporting, D-07). */
const SEARCH_THINK_MS = Number(
  args.find((a) => a.startsWith("--search-think-ms="))?.split("=")[1] ?? 0,
);
const ASK_THINK_MS = Number(args.find((a) => a.startsWith("--ask-think-ms="))?.split("=")[1] ?? 0);

const MRO_BASE_URL = process.env.MRO_BASE_URL ?? "http://localhost:3003";
const COOKIE_NAME = process.env.MRO_AUTH_COOKIE_NAME ?? "mro_session";
const SEARCH_GATE_MS = 300;
const ASK_GATE_MS = 2500;
const windowMs = Number(DURATION.replace(/s$/, "")) * 1000 * 2 + 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Run one k6 scenario; resolves with the process exit code. */
function runK6(scenarioScript, summaryName, extraEnv) {
  const env = {
    MRO_BASE_URL,
    MRO_AUTH_COOKIE_NAME: COOKIE_NAME,
    DURATION,
    ...process.env,
    ...extraEnv,
  };
  const promEnv = prom
    ? {
        K6_PROMETHEUS_RW_SERVER_URL: "http://localhost:9090/api/v1/write",
        K6_PROMETHEUS_RW_TREND_STATS: "p(50),p(95),p(99),avg,max",
      }
    : {};
  const mergedEnv = { ...env, ...promEnv };
  const envArgs = Object.entries(mergedEnv)
    .filter(
      ([key]) =>
        key.startsWith("MRO_") ||
        [
          "DURATION",
          "SEARCH_VUS",
          "ASK_VUS",
          "SEARCH_THINK_MS",
          "ASK_THINK_MS",
          "VIEWER_EMAIL",
          "VIEWER_PASSWORD",
          "ENGINEER_EMAIL",
          "ENGINEER_PASSWORD",
          "K6_PROMETHEUS_RW_SERVER_URL",
          "K6_PROMETHEUS_RW_TREND_STATS",
        ].includes(key),
    )
    .flatMap(([key, value]) => ["-e", `${key}=${value}`]);

  const outArgs = prom ? ["--out", "experimental-prometheus-rw"] : [];

  if (k6Available()) {
    const child = spawn(
      "k6",
      [
        "run",
        ...envArgs,
        "--summary-export",
        `scripts/loadtest/results/mro/${summaryName}`,
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
    // envArgs is already the flat ["-e", "K=V", …] flag list.
    ...envArgs,
    "grafana/k6:latest",
    "run",
    "--summary-export",
    `scripts/loadtest/results/mro/${summaryName}`,
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

function scenarioP95(summary) {
  const metric = summary?.metrics?.http_req_duration;
  // k6 summary-export shape: {type, contains, values: {"p(95)": …, avg, …}}
  const values = metric?.values ?? metric;
  if (typeof values?.["p(95)"] === "number") return values["p(95)"];
  return null;
}

mkdirSync(resultsDir, { recursive: true });

if (!(await healthy(`${MRO_BASE_URL}/healthz`))) {
  console.error(`mro web is not healthy at ${MRO_BASE_URL} — start compose profile "mro" first`);
  process.exit(1);
}
const ready = await fetch(`${MRO_BASE_URL}/readyz`).then((r) => r.json());
if (ready.dependencies?.model !== "up" || ready.dependencies?.provider !== "up") {
  console.error(
    `[runner] app readyz is degraded: ${JSON.stringify(ready.dependencies)} — ` +
      "the ask gate needs the mock provider up and the RUL artifact loaded",
  );
  process.exit(1);
}

console.info(
  `[runner] stack healthy — search ${SEARCH_VUS} VU + ask ${ASK_VUS} VU, ${DURATION} each (sequential)`,
);
if (!k6Available()) {
  console.info("[runner] no k6 binary — pulling grafana/k6 image");
  const dockerProbe = spawnSync("docker", ["info"], { encoding: "utf8" });
  const pullArgs =
    dockerProbe.status === 0
      ? ["docker", "pull", "grafana/k6:latest"]
      : ["sg", "docker", "-c", "docker pull grafana/k6:latest"];
  const pull = spawnSync(pullArgs[0], pullArgs.slice(1), { stdio: "inherit" });
  if (pull.status !== 0) {
    console.error("[runner] could not obtain k6 (binary or docker image)");
    process.exit(1);
  }
}

// Stale results must never survive into a verdict.
for (const name of ["k6-search-summary.json", "k6-ask-summary.json", "probe-latency.json"]) {
  try {
    rmSync(join(resultsDir, name));
  } catch {
    /* absent — fine */
  }
}

/**
 * Host-noise evidence (honest reporting, D-07): this dev host is co-tenanted
 * (turnaround-iq dev + prod-demo stacks share the machine), so the report
 * must be able to say HOW loaded the box was during the run. Snapshot uptime
 * + per-container CPU before, during and after the scenarios.
 */
async function noiseSnapshot(label) {
  const uptime = spawnSync("cat", ["/proc/loadavg"], { encoding: "utf8" }).stdout.trim();
  const stats = spawnSync(
    "docker",
    ["stats", "--no-stream", "--format", "{{.Name}} {{.CPUPerc}} {{.MemUsage}}"],
    { encoding: "utf8" },
  );
  writeFileSync(
    join(resultsDir, `host-noise-${label}.txt`),
    `# ${new Date().toISOString()} (${label})\nloadavg: ${uptime}\n\n${stats.stdout}`,
  );
  console.info(
    `[runner] noise snapshot '${label}': load ${uptime.split(" ").slice(0, 3).join(" ")}`,
  );
}
await noiseSnapshot("before");

// Independent probe covers BOTH scenarios (paced 2 search/s + 0.4 ask/s).
const phasesFile = join(resultsDir, "phases.json");
const probeProcess = spawn(process.execPath, ["scripts/loadtest/mro-probe-latency.mjs"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    MRO_BASE_URL,
    MRO_PROBE_OUT: join(resultsDir, "probe-latency.json"),
    MRO_PROBE_WINDOW_MS: String(windowMs),
    MRO_PHASES_FILE: phasesFile,
  },
});
const probeDone = new Promise((resolve) => probeProcess.on("exit", resolve));

// Phase log for the probe's per-scenario attribution (load conditions differ
// per scenario; whole-window probe numbers mix them).
const phases = { search: { start: 0, end: 0 }, ask: { start: 0, end: 0 } };
writeFileSync(phasesFile, JSON.stringify(phases));

const searchStart = Date.now();
const searchExit = await runK6("mro-search-load.js", "k6-search-summary.json", {
  SEARCH_VUS: String(SEARCH_VUS),
  SEARCH_THINK_MS: String(SEARCH_THINK_MS),
});
console.info(`[runner] k6 search scenario exited with ${searchExit}`);
await noiseSnapshot("mid");
const askStart = Date.now();
phases.search = { start: searchStart, end: askStart };
writeFileSync(phasesFile, JSON.stringify(phases));

const askExit = await runK6("mro-ask-load.js", "k6-ask-summary.json", {
  ASK_VUS: String(ASK_VUS),
  ASK_THINK_MS: String(ASK_THINK_MS),
});
console.info(`[runner] k6 ask scenario exited with ${askExit}`);
phases.ask = { start: askStart, end: Date.now() };
writeFileSync(phasesFile, JSON.stringify(phases));

console.info("[runner] waiting for the latency probe window to close…");
await Promise.race([probeDone, sleep(90_000)]);
await noiseSnapshot("after");

const searchSummary = readSummary("k6-search-summary.json");
const askSummary = readSummary("k6-ask-summary.json");
let probe = null;
try {
  probe = JSON.parse(readFileSync(join(resultsDir, "probe-latency.json"), "utf8"));
} catch {
  console.warn("[runner] probe result missing — probe may still be running or failed");
}

const searchK6P95 = scenarioP95(searchSummary);
const askK6P95 = scenarioP95(askSummary);
// Per-phase probe stats attribute samples to the scenario they ran under;
// whole-window numbers mix both load conditions and are kept for context.
const searchProbeP95 = probe?.phases?.search?.p95 ?? probe?.search?.p95 ?? null;
const askProbeP95 = probe?.phases?.ask?.p95 ?? probe?.ask?.p95 ?? null;

const searchPass =
  searchK6P95 !== null && searchProbeP95 !== null
    ? searchK6P95 < SEARCH_GATE_MS && searchProbeP95 < SEARCH_GATE_MS
    : searchK6P95 !== null
      ? searchK6P95 < SEARCH_GATE_MS
      : searchProbeP95 !== null && searchProbeP95 < SEARCH_GATE_MS;
const askPass =
  askK6P95 !== null && askProbeP95 !== null
    ? askK6P95 < ASK_GATE_MS && askProbeP95 < ASK_GATE_MS
    : askK6P95 !== null
      ? askK6P95 < ASK_GATE_MS
      : askProbeP95 !== null && askProbeP95 < ASK_GATE_MS;

writeFileSync(
  join(resultsDir, "verdict.json"),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      duration: DURATION,
      offer: {
        searchVus: SEARCH_VUS,
        searchThinkMs: SEARCH_THINK_MS,
        askVus: ASK_VUS,
        askThinkMs: ASK_THINK_MS,
        note:
          "thinkMs=0 is a closed-loop saturation offer (throughput probe); " +
          "thinkMs>0 models concurrent users and makes the gates per-request latency claims",
      },
      gates: {
        search: { gate: "p95 < 300 ms", k6: searchK6P95, probe: searchProbeP95, pass: searchPass },
        ask: { gate: "p95 < 2500 ms", k6: askK6P95, probe: askProbeP95, pass: askPass },
      },
      passed: searchPass && askPass,
    },
    null,
    2,
  ),
);

console.info(
  `[runner] offer: search ${SEARCH_VUS} VU think=${SEARCH_THINK_MS}ms · ask ${ASK_VUS} VU think=${ASK_THINK_MS}ms`,
);
console.info(
  `[runner] SEARCH gate p95 < ${SEARCH_GATE_MS} ms @ ${SEARCH_VUS} VU: k6=${searchK6P95 ?? "n/a"}ms probe=${searchProbeP95 ?? "n/a"}ms → ${searchPass ? "PASS" : "FAIL"}`,
);
console.info(
  `[runner] ASK gate    p95 < ${ASK_GATE_MS} ms @ ${ASK_VUS} VU (mock): k6=${askK6P95 ?? "n/a"}ms probe=${askProbeP95 ?? "n/a"}ms → ${askPass ? "PASS" : "FAIL"}`,
);
console.info("[runner] raw evidence: scripts/loadtest/results/mro/");
if (searchExit !== 0 || askExit !== 0) process.exitCode = 1;
if (!searchPass || !askPass) process.exitCode = 1;
