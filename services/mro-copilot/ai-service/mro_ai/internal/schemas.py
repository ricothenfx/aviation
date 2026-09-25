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


# --- Hybrid retrieval (api-contracts.md §3, ADR-0010) -----------------------


class RetrievalFilters(BaseModel):
    """Metadata filters applied to both retrieval legs before fusion."""

    doc_types: list[Annotated[str, Field(min_length=1, max_length=4)]] | None = Field(
        default=None, alias="docTypes"
    )
    ata_chapters: list[Annotated[str, Field(min_length=1, max_length=4)]] | None = Field(
        default=None, alias="ataChapters"
    )
    revision: Annotated[str, Field(min_length=1, max_length=32)] | None = None


class RetrievalSearchRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    query: Annotated[str, Field(min_length=1, max_length=2_000)]
    k: Annotated[int, Field(ge=1, le=20)] = 8
    filters: RetrievalFilters | None = None


class RetrievalHit(BaseModel):
    """One fused result — wire shape mirrors SearchHit (api-contracts.md §1).

    ``vector_score`` / ``term_coverage`` are grounding-quality signals (F3,
    additive): query-chunk cosine (null in lexical mode) and query-lexeme
    coverage. The app's guardrail blends them; ranking never uses them.
    """

    chunk_id: str = Field(alias="chunkId")
    manual_id: str = Field(alias="manualId")
    doc_type: str = Field(alias="docType")
    task_no: str = Field(alias="taskNo")
    ata_chapter: str = Field(alias="ataChapter")
    section_path: str = Field(alias="sectionPath")
    page: int
    revision: str
    effective_date: str = Field(alias="effectiveDate")
    snippet: str
    score: float
    vector_score: float | None = Field(default=None, alias="vectorScore")
    term_coverage: float = Field(default=0.0, alias="termCoverage")


class RetrievalSearchResponse(BaseModel):
    """`mode` flags degraded retrieval: hybrid | lexical (FR-7)."""

    mode: Literal["hybrid", "lexical"]
    results: list[RetrievalHit]
    latency_ms: int = Field(alias="latencyMs")


# --- Ingest (api-contracts.md §1 Admin/Ingest + §3) -------------------------


class IngestCounts(BaseModel):
    new: int
    changed: int
    unchanged: int
    removed: int


class IngestReportResponse(BaseModel):
    corpus_digest: str = Field(alias="corpusDigest")
    embedding_model: str = Field(alias="embeddingModel")
    manuals_touched: int = Field(alias="manualsTouched")
    chunks: IngestCounts
    duration_ms: int = Field(alias="durationMs")
    status: str


# --- RUL serving (api-contracts.md §3, ADR-0011) -----------------------------
# Provenance is mandatory on every RUL number (FR-16, behavioral contract §4):
# modelVersion + modelSha256 travel with every prediction.


class RulPredictRequest(BaseModel):
    unit_id: str = Field(alias="unitId", min_length=1, max_length=64)
    model_config = ConfigDict(populate_by_name=True)

    cycle: int | None = Field(default=None, ge=1)


class RulPrediction(BaseModel):
    unit_id: str = Field(alias="unitId")
    cycle: int
    rul_cycles: int = Field(alias="rulCycles", ge=0)
    band_low: int = Field(alias="bandLow", ge=0)
    band_high: int = Field(alias="bandHigh", ge=0)
    model_version: str = Field(alias="modelVersion")
    model_sha256: str = Field(alias="modelSha256")


class RulScoreFleetRequest(BaseModel):
    unit_ids: list[Annotated[str, Field(min_length=1, max_length=64)]] = Field(
        alias="unitIds", min_length=1, max_length=500
    )
    model_config = ConfigDict(populate_by_name=True)


class RulScoreFleetResponse(BaseModel):
    model_version: str = Field(alias="modelVersion")
    model_sha256: str = Field(alias="modelSha256")
    results: list[RulPrediction]
    """Units skipped for lack of history — the app composes latestRul: null
    for them (additive field; never a fabricated 0, D-15 precedent)."""
    insufficient_history: list[str] = Field(alias="insufficientHistory")


class RulBackfillEntry(BaseModel):
    unit_id: str = Field(alias="unitId", min_length=1, max_length=64)
    model_config = ConfigDict(populate_by_name=True)

    cycles: list[Annotated[int, Field(ge=1)]] = Field(min_length=1, max_length=48)


class RulBackfillRequest(BaseModel):
    """Offline scoring at explicit historical cycles — used by the app to
    backfill a trend series for units that have no predictions yet. Feature
    windows stop AT each requested cycle (no look-ahead)."""

    entries: list[RulBackfillEntry] = Field(min_length=1, max_length=500)


class RulBackfillResponse(BaseModel):
    model_version: str = Field(alias="modelVersion")
    model_sha256: str = Field(alias="modelSha256")
    results: list[RulPrediction]
    skipped: list[str] = Field(default_factory=list)


class ModelMetrics(BaseModel):
    rmse: float
    nasaScore: float


class ModelInfoResponse(BaseModel):
    version: str
    sha256: str
    trainedAt: str
    dataset: str
    metrics: ModelMetrics
