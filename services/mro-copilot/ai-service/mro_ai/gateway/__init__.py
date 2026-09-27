"""Gateway entry point (ADR-0003 shape, Python port per ADR-0012)."""

from __future__ import annotations

import os
from collections.abc import Mapping

from mro_ai.gateway.base import (
    ChatMessage,
    CompletionRequest,
    CompletionResult,
    EmbeddingResult,
    LlmProvider,
    ProviderUnavailableError,
    TokenUsage,
)
from mro_ai.gateway.mock import MockProvider

__all__ = [
    "ChatMessage",
    "CompletionRequest",
    "CompletionResult",
    "EmbeddingResult",
    "Gateway",
    "LlmProvider",
    "ProviderUnavailableError",
    "TokenUsage",
]


class Gateway:
    """Single entry point for all provider access (ADR-0003 §decision).

    Wraps one provider; failures become ProviderUnavailableError so callers
    degrade gracefully instead of leaking vendor errors.
    """

    def __init__(self, provider: LlmProvider) -> None:
        self._provider = provider

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> Gateway:
        source = env if env is not None else os.environ
        requested = source.get("LLM_PROVIDER", "mock")
        if requested == "mock":
            return Gateway(MockProvider())
        if requested == "off":
            raise ProviderUnavailableError(
                "LLM provider disabled by configuration (LLM_PROVIDER=off); "
                "degrading to extractive/lexical behaviour is expected"
            )
        if requested == "openai-compatible":
            # ADR-0017: the ai-service owns the EMBEDDING vector space
            # (mock-hashed-ngram-384, ADR-0012 §2 / ADR-0010). Switching
            # embeddings to a real model changes dimensionality and voids the
            # committed corpus + eval until a dedicated migration ADR. Real
            # LLM for mro ANSWERS is configured on mro-web (TS gateway), where
            # the citation guardrails apply unchanged.
            raise ProviderUnavailableError(
                'LLM provider "openai-compatible" is deliberately not available '
                "in the ai-service: this service owns the mock-hashed-ngram-384 "
                "embedding vector space (ADR-0012 §2), and switching embeddings "
                "requires a dimension migration + full re-ingest + eval re-run "
                "under a future ADR. Set LLM_PROVIDER=mock here; configure "
                "LLM_PROVIDER=openai-compatible on mro-web for real answers."
            )
        raise ProviderUnavailableError(
            f'LLM provider "{requested}" is registered but not implemented; '
            "set LLM_PROVIDER=mock for offline development"
        )

    @property
    def provider_name(self) -> str:
        return str(self._provider.name)

    async def complete(self, request: CompletionRequest) -> CompletionResult:
        try:
            return await self._provider.complete(request)
        except ProviderUnavailableError:
            raise
        except Exception as err:
            raise ProviderUnavailableError(
                f'provider "{self._provider.name}" failed: {err}'
            ) from err

    async def embed(self, text: str) -> EmbeddingResult:
        try:
            return await self._provider.embed(text)
        except ProviderUnavailableError:
            raise
        except Exception as err:
            raise ProviderUnavailableError(
                f'provider "{self._provider.name}" failed: {err}'
            ) from err
