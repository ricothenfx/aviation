"""Internal API routes (api-contracts.md §3, bearer AI_SERVICE_TOKEN)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from mro_ai.gateway import Gateway, ProviderUnavailableError
from mro_ai.gateway.mock import EMBED_MODEL_ID
from mro_ai.internal.auth import require_service_token
from mro_ai.internal.schemas import EmbedRequest, EmbedResponse, TokenUsage
from mro_ai.metrics import EMBED_LATENCY, EMBED_REQUESTS

router = APIRouter(dependencies=[Depends(require_service_token)])


@router.post("/internal/v1/embed")
async def embed(payload: EmbedRequest, request: Request) -> EmbedResponse:
    """Embed a batch of texts with the configured gateway provider.

    Deterministic with the mock provider: identical texts yield identical
    384-dim vectors (asserted by contract tests on both runtimes).
    """
    gateway: Gateway | None = request.app.state.gateway
    if gateway is None:
        raise ProviderUnavailableError("no embedding provider configured (set LLM_PROVIDER=mock)")
    with EMBED_LATENCY.time():
        vectors: list[list[float]] = []
        input_tokens = 0
        for text in payload.texts:
            result = await gateway.embed(text)
            vectors.append(result.vector)
            input_tokens += result.usage.input_tokens
    EMBED_REQUESTS.inc()
    return EmbedResponse(
        model=EMBED_MODEL_ID,
        vectors=vectors,
        usage=TokenUsage(inputTokens=input_tokens),
    )
