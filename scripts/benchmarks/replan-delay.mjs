#!/usr/bin/env node
/**
 * Loader-breakdown replan benchmark (milestones.md §F3 DoD):
 *   total delay 47 → ≤ 9 min · computation < 2 s · deterministic plan hash.
 *
 * Pure pipeline (no stack required): reference day → canonical inject instant →
 * do-nothing cascade vs constraint-scheduled plan. CI runs this in the compose
 * job; the same thresholds are asserted in the domain unit suite
 * (replan-bench.test.ts).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const run = spawnSync(
  "pnpm",
  ["--filter", "@aviation/tiq-domain", "exec", "tsx", "src/replan-bench-cli.ts"],
  { encoding: "utf8", cwd: repoRoot, timeout: 120_000 },
);

if (run.status !== 0) {
  console.error(run.stderr || run.stdout);
  process.exit(1);
}

const match = run.stdout.match(/\{[\s\S]*\}/);
if (!match) {
  console.error("benchmark produced no JSON output:\n" + run.stdout);
  process.exit(1);
}
const metrics = JSON.parse(match[0]);

const checks = [
  ["baseline delay (unmanaged) = 47 min", metrics.baselineDelayMin === 47],
  ["replanned delay ≤ 9 min", metrics.totalDelayMin <= 9 && metrics.totalDelayMin >= 0],
  ["computation < 2000 ms", metrics.computeMs < 2000],
  ["plan hash present", /^[0-9a-f]{64}$/.test(metrics.planHash)],
  ["alert lead ≥ 10 min", metrics.alertLeadTimeMin >= 10],
];

console.info("\nReplan benchmark — loader breakdown (milestones.md §F3)");
console.info(`  flight                : ${metrics.flightNo}`);
console.info(`  inject at             : ${metrics.injectAt}`);
console.info(`  baseline delay        : ${metrics.baselineDelayMin} min`);
console.info(`  replanned delay       : ${metrics.totalDelayMin} min`);
console.info(`  computation           : ${metrics.computeMs} ms`);
console.info(`  plan hash             : ${metrics.planHash.slice(0, 16)}…`);
console.info(`  alert lead time       : ${metrics.alertLeadTimeMin} min`);
console.info("");

let failed = false;
for (const [label, ok] of checks) {
  console.info(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  failed = failed || !ok;
}
if (failed) process.exit(1);
console.info("\nAll F3 replan benchmark thresholds met.\n");
