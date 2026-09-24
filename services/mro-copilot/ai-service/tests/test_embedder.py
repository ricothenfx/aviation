"""Mock embedder properties (ADR-0012 §2): determinism, shape, normalization."""

from __future__ import annotations

import pytest

from mro_ai.gateway.mock import EMBED_DIMENSIONS, MockProvider, hashed_ngram_embedding

TEXT_A = "Hydraulic reservoir pressurization check before APU start."
TEXT_B = "No airflow after engine start — bleed pressure low."


@pytest.mark.asyncio
async def test_same_text_yields_identical_vector() -> None:
    provider = MockProvider()
    first = await provider.embed(TEXT_A)
    second = await provider.embed(TEXT_A)
    assert first.vector == second.vector


@pytest.mark.asyncio
async def test_different_text_yields_different_vector() -> None:
    provider = MockProvider()
    first = await provider.embed(TEXT_A)
    second = await provider.embed(TEXT_B)
    assert first.vector != second.vector


@pytest.mark.asyncio
async def test_vector_is_384_dim_and_l2_normalized() -> None:
    provider = MockProvider()
    result = await provider.embed(TEXT_A)
    assert len(result.vector) == EMBED_DIMENSIONS
    norm = sum(v * v for v in result.vector) ** 0.5
    assert norm == pytest.approx(1.0, abs=1e-9)
    assert all(v >= 0.0 for v in result.vector)
    assert result.usage.input_tokens > 0


@pytest.mark.asyncio
async def test_degenerate_input_returns_zero_vector() -> None:
    provider = MockProvider()
    result = await provider.embed("")
    assert result.vector == [0.0] * EMBED_DIMENSIONS


def test_embedding_is_stable_across_calls_and_encoding() -> None:
    direct = hashed_ngram_embedding(TEXT_A)
    assert direct == hashed_ngram_embedding(TEXT_A)
    assert direct == hashed_ngram_embedding(
        "Hydraulic reservoir pressurization ".upper() + "check before APU start."
    )
    # Deterministic hashing (blake2b), not Python's randomized hash(): the
    # bucket signature must be reproducible in a fresh interpreter too.
    assert sum(1 for v in direct if v > 0) > 10
