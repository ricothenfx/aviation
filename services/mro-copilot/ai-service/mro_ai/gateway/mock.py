"""Deterministic offline gateway provider (ADR-0003, ADR-0012).

`complete` returns a deterministic placeholder synthesis; `embed` is the
mandatory mock embedder: hashed bag-of-character-3-grams, 384 dimensions,
L2-normalized. Same input ⇒ same output, zero network, zero cost — the vector
space for index- and query-time embeddings is internally consistent by
construction because this single provider produces both (ADR-0012 §2).
"""

from __future__ import annotations

import hashlib
import math

from mro_ai.gateway.base import (
    CompletionRequest,
    CompletionResult,
    EmbeddingResult,
    LlmProvider,
    ProviderName,
    TokenUsage,
    estimate_tokens,
)

EMBED_DIMENSIONS = 384
NGRAM_SIZE = 3
EMBED_MODEL_ID = "mock-hashed-ngram-384"


class MockProvider(LlmProvider):
    name: ProviderName = "mock"

    async def complete(self, request: CompletionRequest) -> CompletionResult:
        user_turns = [m for m in request.messages if m.role == "user"]
        last_user = user_turns[-1].content if user_turns else ""
        digest = last_user.strip()[:120] or "the requested item"
        text = (
            "Deterministic mock response (offline mode: LLM_PROVIDER=mock — zero network, "
            f"zero cost). Request digest: {digest}. Configure a real provider behind the "
            "same gateway for a grounded answer."
        )
        input_tokens = estimate_tokens("\n".join(m.content for m in request.messages))
        return CompletionResult(
            text=text,
            provider=self.name,
            usage=TokenUsage(input_tokens=input_tokens, output_tokens=estimate_tokens(text)),
        )

    async def embed(self, text: str) -> EmbeddingResult:
        return EmbeddingResult(
            vector=hashed_ngram_embedding(text),
            usage=TokenUsage(input_tokens=estimate_tokens(text), output_tokens=0),
        )


def hashed_ngram_embedding(text: str, dimensions: int = EMBED_DIMENSIONS) -> list[float]:
    """Deterministic hashed bag-of-character-n-grams, L2-normalized.

    - case-folded; character trigrams over the folded text (short inputs are
      padded with boundary markers so they still produce signal)
    - each trigram is hashed with blake2b (stable across runs/processes —
      never Python's randomized builtin hash) into one of `dimensions` buckets
    - bag counts are accumulated, then the vector is L2-normalized; a
      degenerate all-zero vector is returned as-is (norm 0 → no direction)
    """
    folded = text.strip().lower()
    padded = f"\u2423{folded}\u2423" if folded else ""
    vector = [0.0] * dimensions
    for i in range(max(0, len(padded) - NGRAM_SIZE + 1)):
        gram = padded[i : i + NGRAM_SIZE]
        digest = hashlib.blake2b(gram.encode("utf-8"), digest_size=8).digest()
        bucket = int.from_bytes(digest, "big") % dimensions
        vector[bucket] += 1.0

    norm = math.sqrt(sum(v * v for v in vector))
    if norm == 0.0:
        return vector
    return [v / norm for v in vector]
