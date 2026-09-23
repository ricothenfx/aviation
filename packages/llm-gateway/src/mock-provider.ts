import type { CompletionRequest, CompletionResult, EmbeddingResult, LlmProvider } from "./types";

/**
 * Deterministic offline provider (ADR-0003): same input ⇒ same output, zero network,
 * realistic response shape. Keeps demos and tests reproducible at zero cost.
 */
export class MockProvider implements LlmProvider {
  readonly name = "mock" as const;

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const userTurns = request.messages.filter((m) => m.role === "user");
    const lastUser = userTurns.at(-1)?.content ?? "";
    const inputTokens = estimateTokens(request.messages.map((m) => m.content).join("\n"));
    const text = renderExplanation(lastUser);
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

function deterministicEmbedding(text: string, dimensions = 8): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (let i = 0; i < text.length; i++) {
    vector[i % dimensions] = (vector[i % dimensions]! + text.charCodeAt(i)) % 97;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => Number((v / norm).toFixed(4)));
}
