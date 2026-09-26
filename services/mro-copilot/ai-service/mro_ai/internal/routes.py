"""Internal API routes (api-contracts.md §3, bearer AI_SERVICE_TOKEN)."""

from __future__ import annotations

from typing import Any

import anyio
from fastapi import APIRouter, Depends, Request

from mro_ai.config import Config
from mro_ai.gateway import Gateway, ProviderUnavailableError
from mro_ai.gateway.mock import EMBED_MODEL_ID
from mro_ai.ingest import default_corpus_dir, run_ingest
from mro_ai.internal.auth import require_service_token
from mro_ai.internal.schemas import (
    EmbedRequest,
    EmbedResponse,
    IngestCounts,
    IngestReportResponse,
    ModelInfoResponse,
    ModelMetrics,
    RetrievalHit,
    RetrievalSearchRequest,
    RetrievalSearchResponse,
    RulBackfillRequest,
    RulBackfillResponse,
    RulPrediction,
    RulPredictRequest,
    RulScoreFleetRequest,
    RulScoreFleetResponse,
    TokenUsage,
)
from mro_ai.metrics import EMBED_LATENCY, EMBED_REQUESTS, INGEST_CHUNKS, RUL_LATENCY, RUL_REQUESTS
from mro_ai.retrieval import RetrievalService, SearchFilters
from mro_ai.rul import ModelNotLoadedError, RulService

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
    # IngestInProgressError propagates to the 409 INGEST_IN_PROGRESS problem
    # handler in main.py (api-contracts.md §1/§2 error envelope, not bare {"detail"}).
    report = await run_ingest(config.database_url, default_corpus_dir(), gateway)
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


# --- RUL serving (api-contracts.md §3, ADR-0011) ------------------------------
# Errors are raised as domain exceptions; create_app() maps them to the
# RFC-7807 problem shape: missing/hash-mismatched artifact ⇒ 503
# MODEL_NOT_LOADED (no predictions without provenance, architecture.md §6);
# too little history ⇒ 422 INSUFFICIENT_HISTORY (the app composes
# latestRul: null — never a fabricated prediction, D-15 honesty precedent).


def _rul_service(request: Request) -> RulService:
    service: RulService | None = getattr(request.app.state, "rul", None)
    if service is None:
        raise ModelNotLoadedError("RUL predictor not initialized")
    return service


def _prediction_to_schema(prediction: Any) -> dict[str, object]:
    return {
        "unitId": prediction.unit_id,
        "cycle": prediction.cycle,
        "rulCycles": prediction.rul_cycles,
        "bandLow": prediction.band_low,
        "bandHigh": prediction.band_high,
        "modelVersion": prediction.model_version,
        "modelSha256": prediction.model_sha256,
    }


def _call_predict(service: RulService, unit_id: str, cycle: int | None) -> Any:
    """Blocking predict — dispatched to a worker thread by the routes."""
    return service.predict(unit_id, cycle)


@router.post("/internal/v1/rul/predict")
async def rul_predict(payload: RulPredictRequest, request: Request) -> RulPrediction:
    """Predict RUL for one unit at its latest cycle (or `cycle` if given)."""
    service = _rul_service(request)
    with RUL_LATENCY.time():
        prediction = await anyio.to_thread.run_sync(
            _call_predict, service, payload.unit_id, payload.cycle
        )
    RUL_REQUESTS.inc()
    return RulPrediction.model_validate(_prediction_to_schema(prediction))


@router.post("/internal/v1/rul/score-fleet")
async def rul_score_fleet(payload: RulScoreFleetRequest, request: Request) -> RulScoreFleetResponse:
    """Score a batch of units synchronously; per-unit results carry
    provenance; short-history units are reported in insufficientHistory
    (additive — the app composes latestRul: null for them). One bulk history
    round trip serves the whole batch (PRD §7 latency budget)."""
    service = _rul_service(request)
    info = service.registry_info()  # fail fast on a missing/mismatched artifact
    with RUL_LATENCY.time():
        predictions, insufficient = await anyio.to_thread.run_sync(
            service.score_fleet, payload.unit_ids
        )
    RUL_REQUESTS.inc(len(predictions))
    return RulScoreFleetResponse(
        modelVersion=info.version,
        modelSha256=info.sha256,
        results=[RulPrediction.model_validate(_prediction_to_schema(p)) for p in predictions],
        insufficientHistory=insufficient,
    )


@router.post("/internal/v1/rul/backfill")
async def rul_backfill(payload: RulBackfillRequest, request: Request) -> RulBackfillResponse:
    """Offline scoring at explicit historical cycles (trend backfill, F4
    additive): one bulk history round trip, batched predict, no look-ahead.
    Units that cannot support a cycle are reported in `skipped`."""
    service = _rul_service(request)
    info = service.registry_info()
    entries = [(entry.unit_id, list(entry.cycles)) for entry in payload.entries]
    with RUL_LATENCY.time():
        predictions, skipped = await anyio.to_thread.run_sync(service.backfill, entries)
    RUL_REQUESTS.inc(len(predictions))
    return RulBackfillResponse(
        modelVersion=info.version,
        modelSha256=info.sha256,
        results=[RulPrediction.model_validate(_prediction_to_schema(p)) for p in predictions],
        skipped=skipped,
    )


@router.get("/internal/v1/model")
async def model_info(request: Request) -> ModelInfoResponse:
    """Current artifact provenance + committed metrics (api-contracts §3)."""
    service = _rul_service(request)
    info = service.registry_info()
    return ModelInfoResponse(
        version=info.version,
        sha256=info.sha256,
        trainedAt=info.trained_at,
        dataset=info.dataset,
        metrics=ModelMetrics(rmse=info.metrics["rmse"], nasaScore=info.metrics["nasaScore"]),
    )
