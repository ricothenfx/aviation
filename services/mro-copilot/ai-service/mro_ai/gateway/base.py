"""Gateway port — Python port of the ADR-0003 interface (ADR-0012 §2).

Same provider names (`mock | openai-compatible | bedrock-shape`), same
`ProviderUnavailableError` semantics and token-accounting shape as
`packages/llm-gateway` in TypeScript. Cross-language interface parity is
asserted by contract tests on both runtimes; embedding vector parity is
explicitly NOT required (ADR-0012: one Python provider owns the vector space).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

ProviderName = Literal["mock", "openai-compatible", "bedrock-shape"]


class ProviderUnavailableError(Exception):
    """Raised when the configured provider cannot serve a request.

    Callers must degrade gracefully (extractive answers, lexical-only search)
    and label the answer source honestly (ADR-0003 §decision, FR-12).
    """


@dataclass(frozen=True)
class ChatMessage:
    role: Literal["system", "user", "assistant"]
    content: str


@dataclass(frozen=True)
class CompletionRequest:
    messages: list[ChatMessage]
    temperature: float | None = None
    max_tokens: int | None = None


@dataclass(frozen=True)
class TokenUsage:
    input_tokens: int
    output_tokens: int


@dataclass(frozen=True)
class CompletionResult:
    text: str
    provider: ProviderName
    usage: TokenUsage


@dataclass(frozen=True)
class EmbeddingResult:
    vector: list[float]
    usage: TokenUsage


class LlmProvider(Protocol):
    name: ProviderName

    async def complete(self, request: CompletionRequest) -> CompletionResult: ...

    async def embed(self, text: str) -> EmbeddingResult: ...


def estimate_tokens(text: str) -> int:
    """Same ~4-chars-per-token heuristic as the TS mock provider."""
    return max(1, (len(text) + 3) // 4)
