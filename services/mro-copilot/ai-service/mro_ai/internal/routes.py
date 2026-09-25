"""Internal API routes (api-contracts.md §3, bearer AI_SERVICE_TOKEN)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from mro_ai.config import Config
from mro_ai.gateway import Gateway, ProviderUnavailableError
from mro_ai.gateway.mock import EMBED_MODEL_ID
from mro_ai.ingest import IngestInProgressError, default_corpus_dir, run_ingest
from mro_ai.internal.auth import require_service_token
from mro_ai.internal.schemas import (
    EmbedRequest,
    EmbedResponse,
    IngestCounts,
    IngestReportResponse,
    RetrievalHit,
    RetrievalSearchRequest,
    RetrievalSearchResponse,
    TokenUsage,
)
from mro_ai.metrics import EMBED_LATENCY, EMBED_REQUESTS, INGEST_CHUNKS
from mro_ai.retrieval import RetrievalService, SearchFilters

router = APIRouter(dependencies=[Depends(require_service_token)])


@router.post("/internal/v1/embed")
async def embed(payload: EmbedRequest, request: Request) -> EmbedResponse:
    """Embed a batch of texts with the configured gateway provider.

    Deterministic with the mock provider: identical texts yield identical
    384-dim vectors (asserted by contract tests on both runtimes).
    """
    gateway: Gateway | None = getattr(request.app.state, "gateway", None)
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
        model=EMBED_MODEL_ID if gateway.provider_name == "mock" else gateway.provider_name,
        vectors=vectors,
        usage=TokenUsage(inputTokens=input_tokens),
    )


def _filters_from(payload: RetrievalSearchRequest) -> SearchFilters | None:
    if payload.filters is None:
        return None
    return SearchFilters(
        doc_types=payload.filters.doc_types,
        ata_chapters=payload.filters.ata_chapters,
        revision=payload.filters.revision,
    )


@router.post("/internal/v1/retrieval/search")
async def retrieval_search(
    payload: RetrievalSearchRequest, request: Request
) -> RetrievalSearchResponse:
    """Hybrid retrieval (pgvector + tsvector RRF); degrades to lexical.

    The response names its mode so callers can flag degraded retrieval in the
    API/UI honestly (FR-7, architecture.md §4). Query embedding happens inside
    (ADR-0012): when no provider is available the vector leg is skipped and
    the search stays within contract as `mode: "lexical"`.
    """
    service: RetrievalService = request.app.state.retrieval
    result = await service.search(
        query=payload.query,
        k=payload.k,
        filters=_filters_from(payload),
    )
    return RetrievalSearchResponse(
        mode=result.mode,  # type: ignore[arg-type]  # validated "hybrid"|"lexical"
        results=[
            RetrievalHit.model_validate(
                {
                    "chunkId": hit.chunk_id,
                    "manualId": hit.manual_id,
                    "docType": hit.doc_type,
                    "taskNo": hit.task_no,
                    "ataChapter": hit.ata_chapter,
                    "sectionPath": hit.section_path,
                    "page": hit.page,
                    "revision": hit.revision,
                    "effectiveDate": hit.effective_date,
                    "snippet": hit.snippet,
                    "score": hit.score,
                    "vectorScore": hit.vector_score,
                    "termCoverage": hit.term_coverage,
                }
            )
            for hit in result.hits
        ],
        latencyMs=result.latency_ms,
    )


@router.post("/internal/v1/ingest")
async def trigger_ingest(request: Request) -> IngestReportResponse:
    """Run the ingest job (same code path as `python -m mro_ai.ingest`).

    Idempotent: an unchanged corpus yields a no-op report. A concurrent run
    holds the advisory lock → 409 INGEST_IN_PROGRESS (api-contracts §1).
    """
    config: Config = request.app.state.config
    gateway: Gateway | None = getattr(request.app.state, "gateway", None)
    if gateway is None:
        raise ProviderUnavailableError(
            "no embedding provider configured; ingest refuses to run (architecture.md §6)"
        )
    try:
        report = await run_ingest(config.database_url, default_corpus_dir(), gateway)
    except IngestInProgressError as err:
        raise HTTPException(status_code=409, detail=str(err)) from err
    for outcome, count in (
        ("new", report.chunks_new),
        ("changed", report.chunks_changed),
        ("unchanged", report.chunks_unchanged),
        ("removed", report.chunks_removed),
    ):
        if count:
            INGEST_CHUNKS.labels(outcome).inc(count)
    return IngestReportResponse(
        corpusDigest=report.corpus_digest,
        embeddingModel=report.embedding_model,
        manualsTouched=report.manuals_touched,
        chunks=IngestCounts(
            new=report.chunks_new,
            changed=report.chunks_changed,
            unchanged=report.chunks_unchanged,
            removed=report.chunks_removed,
        ),
        durationMs=report.duration_ms,
        status=report.status,
    )
