"""Gateway entry point (ADR-0003 shape, Python port per ADR-0012)."""

from __future__ import annotations

import os

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
    def from_env(env: dict[str, str] | None = None) -> Gateway:
        source = env if env is not None else os.environ
        requested = source.get("LLM_PROVIDER", "mock")
        if requested == "mock":
            return Gateway(MockProvider())
        if requested == "off":
            raise ProviderUnavailableError(
                "LLM provider disabled by configuration (LLM_PROVIDER=off); "
                "degrading to extractive/lexical behaviour is expected"
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
