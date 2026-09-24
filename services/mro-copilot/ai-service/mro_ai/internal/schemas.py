"""Shared pydantic models for the internal API (api-contracts.md §3).

These mirror the zod schemas in apps/mro-copilot/src/lib/ai/contract.ts.
Field parity (camelCase on the wire) is asserted by the committed contract
fixture — keep both sides in lockstep.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

EMBED_DIMENSIONS = 384
EMBED_MAX_BATCH = 96

DependencyState = Literal["up", "down", "not_loaded", "unconfigured"]

EmbedString = Annotated[str, Field(min_length=1, max_length=32_000)]
EmbedVector = Annotated[
    list[float], Field(min_length=EMBED_DIMENSIONS, max_length=EMBED_DIMENSIONS)
]


class TokenUsage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    input_tokens: int = Field(alias="inputTokens", ge=0)


class EmbedRequest(BaseModel):
    texts: list[EmbedString] = Field(min_length=1, max_length=EMBED_MAX_BATCH)


class EmbedResponse(BaseModel):
    model: str
    vectors: list[EmbedVector] = Field(min_length=1, max_length=EMBED_MAX_BATCH)
    usage: TokenUsage


class DependencyReport(BaseModel):
    postgres: DependencyState
    pgvector: DependencyState
    model: DependencyState
    provider: DependencyState


class ReadyResponse(BaseModel):
    status: Literal["ready", "degraded"]
    dependencies: DependencyReport
