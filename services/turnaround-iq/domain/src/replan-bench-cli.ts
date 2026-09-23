import { runReplanBenchmark } from "./replan-bench";

/** CLI for scripts/benchmarks/replan-delay.mjs — prints the metrics as JSON. */
const result = runReplanBenchmark();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
