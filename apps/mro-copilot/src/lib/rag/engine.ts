import type { ChatMessage } from "@aviation/llm-gateway";

import type { RetrievalHit } from "@/lib/ai/contract";
import { GROUNDING, RAG_CONFIG } from "./config";

/**
 * Guardrail + answer-decision engine for the ask flow (architecture.md §3,
 * PRD FR-9..FR-12). PURE — no DB, no HTTP — so refusal/citation invariants
 * are unit-testable without the stack; the route handler composes this with
 * retrieval, the gateway and persistence.
 */

export interface RagBlock {
  /** 1-based index matching the [n] citation marker. */
  index: number;
  hit: RetrievalHit;
  /** Full chunk content (hydrated from the app DB by the route). */
  content: string;
}

export type RefusalReason = "below_grounding_threshold" | "no_valid_citations";

// --- Grounding score ---------------------------------------------------------

/**
 * Grounding score for the retrieved set (calibrated per data-model.md §9 —
 * see eval-reports/grounding-calibration.json and
 * scripts/eval-mro/calibrate-threshold.mjs):
 *   hybrid : max over hits of (W_COVERAGE·termCoverage + W_COSINE·vectorScore)
 *   lexical: max over hits of termCoverage (no cosine available — degraded)
 * 0 when nothing was retrieved. Range [0, 1].
 */
export function groundingScoreFor(mode: "hybrid" | "lexical", hits: RetrievalHit[]): number {
  if (hits.length === 0) return 0;
  const scores = hits.map((hit) =>
    mode === "hybrid" && hit.vectorScore !== null
      ? GROUNDING.W_COVERAGE * hit.termCoverage + GROUNDING.W_COSINE * hit.vectorScore
      : hit.termCoverage,
  );
  return Math.max(...scores);
}

/** Guardrail pre-check (architecture.md §3 step 3): refuse without the LLM. */
export function isBelowGroundingThreshold(mode: "hybrid" | "lexical", score: number): boolean {
  return mode === "lexical"
    ? score < GROUNDING.MIN_COVERAGE_LEXICAL
    : score < GROUNDING.MIN_SCORE_HYBRID;
}

// --- Prompt assembly ---------------------------------------------------------

const SYSTEM_GUARD =
  "You are the MRO Copilot for the fictional NX-320 fleet (simulated corpus). " +
  "Answer the maintainer's question using ONLY the numbered document context below. " +
  "Every claim must end with a citation marker [n] matching the context block it came from. " +
  "If the context does not contain the information needed, reply with exactly 'NOT COVERED' " +
  "followed by a short reason — never invent procedures, torque values, part numbers or steps. " +
  "Keep the answer short and procedural.";

export function buildRagMessages(question: string, blocks: RagBlock[]): ChatMessage[] {
  const contextLines = blocks.map((block) =>
    [
      `[${block.index}] (${block.hit.sectionPath} | p.${block.hit.page} | ${block.hit.revision})`,
      block.content,
    ].join("\n"),
  );
  const userMessage = [
    `Question: ${question}`,
    `MaxBlocks: ${RAG_CONFIG.EXTRACTIVE_TOP_CHUNKS}`,
    "",
    "Context:",
    ...contextLines,
  ].join("\n");
  return [
    { role: "system", content: SYSTEM_GUARD },
    { role: "user", content: userMessage },
  ];
}

// --- Citation post-check (FR-11) ---------------------------------------------

/** All [n] citation markers in the LLM text, in order of appearance. */
export function parseCitationMarkers(text: string): number[] {
  return [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
}

export interface CitationCheck {
  /** Marker indexes that resolve into the retrieved set, first-appearance order. */
  valid: number[];
  /** Marker indexes referencing chunks that were never retrieved (hallucinated). */
  invalid: number[];
}

export function checkCitations(text: string, blockCount: number): CitationCheck {
  const seen = new Set<number>();
  const valid: number[] = [];
  const invalid = new Set<number>();
  for (const marker of parseCitationMarkers(text)) {
    if (marker >= 1 && marker <= blockCount) {
      if (!seen.has(marker)) {
        seen.add(marker);
        valid.push(marker);
      }
    } else {
      invalid.add(marker);
    }
  }
  return { valid, invalid: [...invalid] };
}

/**
 * Strip hallucinated citation markers from the answer text (architecture.md
 * §3 step 5): the presented text may only reference chunks that were actually
 * retrieved (FR-11). Callers must refuse when no valid marker remains.
 */
export function stripCitationMarkers(text: string, indexesToRemove: number[]): string {
  if (indexesToRemove.length === 0) return text;
  const remove = new Set(indexesToRemove);
  return text.replace(/\[(\d+)\]/g, (match, n: string) => (remove.has(Number(n)) ? "" : match));
}

// --- Extractive fallback (FR-12, ADR-0003 degrade path) ----------------------

/**
 * Verbatim concatenation of the top chunks (api-contracts.md §4: source
 * "extractive" ⟺ answer text is verbatim chunk content, concatenated).
 */
export function extractiveAnswerText(
  blocks: RagBlock[],
  maxChunks = RAG_CONFIG.EXTRACTIVE_TOP_CHUNKS,
): string {
  return blocks
    .slice(0, maxChunks)
    .map((block) => block.content)
    .join("\n\n");
}
