/**
 * Guardrail thresholds for the ask flow (architecture.md §3: "config, default
 * from eval calibration"). The defaults trace to the committed calibration run
 * `eval-reports/grounding-calibration.json` (regenerate with
 * `node scripts/eval-mro/calibrate-threshold.mjs`): they satisfy refusal
 * accuracy 100% on the refusal fixture while keeping the golden grounded
 * answer rate >= 80%. Env overrides exist for recalibration runs only.
 */
export const GROUNDING = {
  /** Blend weights over the retrieval quality signals (range [0,1] each). */
  W_COVERAGE: 0.6,
  W_COSINE: 0.4,
  /** hybrid: 0.6·termCoverage + 0.4·vectorCosine must reach this. */
  MIN_SCORE_HYBRID: numEnv("GROUNDING_MIN_SCORE", 0.7),
  /** lexical (degraded): no cosine available — coverage-only bar. */
  MIN_COVERAGE_LEXICAL: numEnv("GROUNDING_MIN_COVERAGE", 0.7),
} as const;

export const RAG_CONFIG = {
  /** Retrieval width for prompting (architecture.md §3: top-k=8). */
  RETRIEVAL_K: 8,
  /** Chunks fed to the extractive fallback / context blocks cap. */
  EXTRACTIVE_TOP_CHUNKS: 3,
} as const;

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a number in [0,1] (got ${raw})`);
  }
  return parsed;
}
