#!/usr/bin/env node
/**
 * ×10 load-run orchestrator (milestones.md §F5, ADR-0007):
 *   1. preflight the compose stack (web/gateway health),
 *   2. start the load producer (prepare + reset, then paced ×10 replay),
 *   3. run the k6 scenario (k6 binary when installed, else the grafana/k6
 *      Docker image on the host network),
 *   4. persist the k6 summary + producer manifest under scripts/loadtest/results
 *      and print the threshold verdict.
 * `--prom` additionally remote-writes k6 metrics to the evidence Prometheus
 * (compose profile `evidence`, ADR-0007) for the Grafana dashboard.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const resultsDir = join(repoRoot, "scripts", "loadtest", "results");

const args = process.argv.slice(2);
const prom = args.includes("--prom");
const rate = Number(args.find((arg) => arg.startsWith("--rate="))?.split("=")[1] ?? 100);
const replicas = Number(args.find((arg) => arg.startsWith("--replicas="))?.split("=")[1] ?? 10);
const rampS = 20;

const TIQ_BASE_URL = process.env.TIQ_BASE_URL ?? "http://localhost:3001";
const GATEWAY_URL = process.env.GATEWAY_HEALTH_URL ?? "http://localhost:4001/healthz";
const producerPort = Number(process.env.LOAD_PRODUCER_PORT ?? 4710);
const durationS = Math.ceil((replicas * 1500) / rate) + rampS + 40;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkHealth(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(url, label, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkHealth(url)) return;
    await sleep(1000);
  }
  throw new Error(`${label} at ${url} did not become healthy in time`);
}

function quote(part) {
  return /\s/.test(part) ? `'${part.replaceAll("'", "'\\''")}'` : part;
}

function runK6() {
  const env = {
    TIQ_BASE_URL,
    WS_URL: process.env.WS_URL ?? "ws://localhost:4001/api/ws",
    PRODUCER_URL: `http://localhost:${producerPort}`,
    CONSUMERS: String(process.env.CONSUMERS ?? 200),
    READERS: String(process.env.READERS ?? 20),
    DURATION: `${durationS}s`,
    AUTH_COOKIE_NAME: process.env.AUTH_COOKIE_NAME ?? "tiq_session",
  };
  const promEnv = { K6_PROMETHEUS_RW_SERVER_URL: "http://localhost:9090/api/v1/write" };
  const direct = spawnSync("k6", ["version"], { encoding: "utf8" });
  if (direct.status === 0) {
    return spawn(
      "k6",
      [
        "run",
        ...Object.entries(env).map(([key, value]) => `-e=${key}=${value}`),
        "--summary-export",
        "scripts/loadtest/results/k6-summary.json",
        ...(prom ? ["--out", "experimental-prometheus-rw"] : []),
        "scripts/loadtest/board-load.js",
      ],
      {
        cwd: repoRoot,
        stdio: "inherit",
        env: prom ? { ...process.env, ...promEnv } : process.env,
      },
    );
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
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    ...(prom ? Object.entries(promEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]) : []),
    "grafana/k6:latest",
    "run",
    "--summary-export",
    "scripts/loadtest/results/k6-summary.json",
    ...(prom ? ["--out", "experimental-prometheus-rw"] : []),
    "scripts/loadtest/board-load.js",
  ];
  // Session may predate docker group membership — `sg docker` is the fallback.
  const probe = spawnSync("docker", ["info"], { encoding: "utf8" });
  const args =
    probe.status === 0
      ? ["docker", ...dockerArgs]
      : ["sg", "docker", "-c", `docker ${dockerArgs.map(quote).join(" ")}`];
  return spawn(args[0], args.slice(1), { cwd: repoRoot, stdio: "inherit" });
}

mkdirSync(resultsDir, { recursive: true });

if (!(await checkHealth(`${TIQ_BASE_URL}/healthz`))) {
  console.error(`web stack is not healthy at ${TIQ_BASE_URL} — start compose first`);
  process.exit(1);
}
if (!(await checkHealth(GATEWAY_URL))) {
  console.error(`realtime gateway is not healthy at ${GATEWAY_URL} — start compose first`);
  process.exit(1);
}

console.info(
  `[runner] stack healthy — producer (replicas=${replicas}, rate=${rate}/s) + k6 ${durationS}s`,
);
const directK6 = spawnSync("k6", ["version"], { encoding: "utf8" }).status === 0;
if (!directK6) {
  // First run may need to pull the image — do it before the producer starts so
  // the consumer ramp is not eaten by the download.
  console.info("[runner] no k6 binary found — using grafana/k6 Docker image (pulling)");
  const probe = spawnSync("docker", ["info"], { encoding: "utf8" });
  const docker = probe.status === 0 ? "docker" : "sg";
  const pullArgs =
    docker === "docker"
      ? ["docker", "pull", "grafana/k6:latest"]
      : ["sg", "docker", "-c", "docker pull grafana/k6:latest"];
  const pull = spawnSync(pullArgs[0], pullArgs.slice(1), { stdio: "inherit" });
  if (pull.status !== 0) {
    console.error("[runner] could not obtain k6 (binary or docker image)");
    process.exit(1);
  }
}
const producer = spawn("pnpm", ["--filter", "@aviation/tiq-simulator", "produce:load"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    LOAD_REPLICAS: String(replicas),
    LOAD_RATE_PER_SEC: String(rate),
    LOAD_START_DELAY_S: String(rampS),
    LOAD_PRODUCER_PORT: String(producerPort),
    TIQ_BASE_URL,
  },
});
try {
  await waitFor(`http://localhost:${producerPort}/healthz`, "load producer");

  const k6 = runK6();
  const k6Exit = await new Promise((resolve) => k6.on("exit", resolve));
  console.info(`[runner] k6 exited with ${k6Exit}`);

  const manifest = await fetch(`http://localhost:${producerPort}/manifest`).then((r) => r.json());
  writeFileSync(join(resultsDir, "load-manifest.json"), JSON.stringify(manifest, null, 2));
  console.info("[runner] manifest written to scripts/loadtest/results/load-manifest.json");

  if (k6Exit !== 0) process.exitCode = k6Exit;
} finally {
  producer.kill("SIGTERM");
  await sleep(2000);
}

try {
  const summary = JSON.parse(readFileSync(join(resultsDir, "k6-summary.json"), "utf8"));
  const p95 = summary.metrics?.ingest_to_board_ms?.["p(95)"];
  const gate = summary.metrics?.ingest_to_board_ms?.thresholds?.["p(95)<1000"]?.ok;
  console.info(
    `[runner] ingestion→board p95=${p95 === undefined ? "?" : Math.round(p95) + "ms"} — DoD gate ${gate ? "PASS" : "FAIL"} (details: scripts/loadtest/results/k6-summary.json)`,
  );
} catch (err) {
  console.warn(`[runner] could not summarize k6 results: ${err.message}`);
}
