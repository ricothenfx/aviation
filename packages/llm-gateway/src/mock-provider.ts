import type { CompletionRequest, CompletionResult, EmbeddingResult, LlmProvider } from "./types";

/**
 * Deterministic offline provider (ADR-0003): same input ⇒ same output, zero network,
 * realistic response shape. Keeps demos and tests reproducible at zero cost.
 *
 * Two completion modes (F3, additive):
 * - **Grounded prompts** (numbered `[n]` context blocks — the RAG prompt shape
 *   built by the caller) produce a cited, extractive-style synthesis: sentences
 *   are lifted verbatim from the BEST-MATCHING context blocks and every claim
 *   carries a `[n]` marker the caller can validate against its retrieved set.
 *   When no block overlaps the question at all, the mock honestly states the
 *   context does not cover it and emits NO citation markers (the caller's
 *   post-check then refuses — never uncited procedural content).
 * - **Any other prompt** keeps the historical deterministic echo so existing
 *   consumers (turnaround-iq copilot explanations) behave unchanged.
 */
export class MockProvider implements LlmProvider {
  readonly name = "mock" as const;

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const userTurns = request.messages.filter((m) => m.role === "user");
    const lastUser = userTurns.at(-1)?.content ?? "";
    const inputTokens = estimateTokens(request.messages.map((m) => m.content).join("\n"));

    const context = parseContextBlocks(lastUser);
    const text =
      context && context.blocks.length > 0
        ? renderGroundedAnswer(context.blocks, context.question, context.maxBlocks)
        : renderExplanation(lastUser);

    return {
      text,
      provider: this.name,
      usage: { inputTokens, outputTokens: estimateTokens(text) },
    };
  }

  async embed(text: string): Promise<EmbeddingResult> {
    return {
      vector: deterministicEmbedding(text),
      usage: { inputTokens: estimateTokens(text) },
    };
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function renderExplanation(prompt: string): string {
  const topic = prompt.trim().slice(0, 120) || "the requested item";
  return [
    "Deterministic mock response (offline mode: LLM_PROVIDER=mock — zero network, zero cost).",
    `Request digest: ${topic}`,
    "Configure a real provider behind the same gateway for a grounded answer.",
  ].join(" ");
}

// --- Grounded synthesis (F3) -------------------------------------------------

interface ContextBlock {
  index: number;
  content: string;
}

function parseContextBlocks(userMessage: string): {
  blocks: ContextBlock[];
  question: string;
  maxBlocks: number;
} | null {
  const markers = [...userMessage.matchAll(/^\[(\d+)\] (.*)$/gm)];
  if (markers.length === 0) return null;

  const questionMatch = userMessage.match(/^Question: (.*)$/m);
  const maxMatch = userMessage.match(/^MaxBlocks: (\d+)$/m);

  const blocks: ContextBlock[] = markers.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end =
      i + 1 < markers.length ? (markers[i + 1]!.index ?? userMessage.length) : userMessage.length;
    return { index: Number(m[1]), content: userMessage.slice(start, end).trim() };
  });

  return {
    blocks,
    question: questionMatch?.[1]?.trim() ?? "",
    maxBlocks: maxMatch ? Math.max(1, Number(maxMatch[1])) : 3,
  };
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "what",
  "which",
  "how",
  "when",
  "where",
  "who",
  "do",
  "does",
  "did",
  "i",
  "my",
  "our",
  "it",
  "its",
  "this",
  "that",
  "at",
  "by",
  "from",
  "as",
  "apply",
  "applies",
  "applys",
  "need",
  "needs",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t) && !/^\d/.test(t));
}

function blockScore(block: ContextBlock, questionTokens: string[]): number {
  if (questionTokens.length === 0) return 0;
  const content = block.content.toLowerCase();
  return questionTokens.filter((t) => content.includes(t)).length / questionTokens.length;
}

/** First N sentences of the block that mention a question token (deterministic). */
function relevantSentences(block: ContextBlock, questionTokens: string[], max: number): string[] {
  const sentences = block.content.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const hits = sentences.filter((s) => {
    const lower = s.toLowerCase();
    return questionTokens.some((t) => lower.includes(t));
  });
  const chosen = hits.length > 0 ? hits : sentences;
  return chosen.slice(0, max).map((s) => s.trim());
}

function renderGroundedAnswer(blocks: ContextBlock[], question: string, maxBlocks: number): string {
  const questionTokens = tokenize(question);
  const scored = blocks
    .map((block) => ({ block, score: blockScore(block, questionTokens) }))
    .sort((a, b) => b.score - a.score || a.block.index - b.block.index);

  const best = scored[0]!;
  if (best.score === 0) {
    // Honest "not covered": no citation markers — the caller's post-check
    // treats an answer without valid citations as a refusal (FR-10/FR-11).
    return (
      "NOT COVERED: the provided document context does not contain the " +
      "information needed to answer this question. Use corpus search instead."
    );
  }

  const top = scored.filter((s) => s.score > 0).slice(0, maxBlocks);
  const parts: string[] = [];
  for (const { block } of top) {
    for (const sentence of relevantSentences(block, questionTokens, 2)) {
      parts.push(`${sentence} [${block.index}]`);
    }
  }
  return parts.join(" ");
}

function deterministicEmbedding(text: string, dimensions = 8): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (let i = 0; i < text.length; i++) {
    vector[i % dimensions] = (vector[i % dimensions]! + text.charCodeAt(i)) % 97;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => Number((v / norm).toFixed(4)));
}
