"""Gateway port semantics (ADR-0003 shape, Python port per ADR-0012)."""

from __future__ import annotations

import pytest

from mro_ai.gateway import (
    ChatMessage,
    CompletionRequest,
    CompletionResult,
    EmbeddingResult,
    Gateway,
    LlmProvider,
    ProviderUnavailableError,
    TokenUsage,
)


def test_from_env_defaults_to_mock() -> None:
    gateway = Gateway.from_env({})
    assert gateway.provider_name == "mock"


def test_from_env_off_raises_provider_unavailable() -> None:
    with pytest.raises(ProviderUnavailableError):
        Gateway.from_env({"LLM_PROVIDER": "off"})


def test_from_env_unknown_provider_raises() -> None:
    with pytest.raises(ProviderUnavailableError):
        Gateway.from_env({"LLM_PROVIDER": "skynet"})


@pytest.mark.asyncio
async def test_mock_complete_is_deterministic_and_accounts_tokens() -> None:
    gateway = Gateway.from_env({})
    request = CompletionRequest(
        messages=[
            ChatMessage(role="system", content="Answer only from context."),
            ChatMessage(role="user", content="How do I check the hydraulic reservoir?"),
        ]
    )
    first = await gateway.complete(request)
    second = await gateway.complete(request)
    assert first.text == second.text
    assert first.provider == "mock"
    assert first.usage.input_tokens > 0
    assert first.usage.output_tokens > 0


class ExplodingProvider(LlmProvider):
    name = "mock"

    async def complete(self, request: CompletionRequest) -> CompletionResult:
        raise RuntimeError("boom")

    async def embed(self, text: str) -> EmbeddingResult:
        raise RuntimeError("boom")


@pytest.mark.asyncio
async def test_provider_failures_become_provider_unavailable() -> None:
    gateway = Gateway(ExplodingProvider())
    with pytest.raises(ProviderUnavailableError, match="boom"):
        await gateway.embed("anything")
    with pytest.raises(ProviderUnavailableError, match="boom"):
        await gateway.complete(CompletionRequest(messages=[ChatMessage(role="user", content="hi")]))


def test_token_usage_shape_matches_ts_contract() -> None:
    usage = TokenUsage(input_tokens=3, output_tokens=0)
    assert usage.input_tokens == 3
