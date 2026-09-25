"""Prometheus metrics (architecture.md §7, engineering-standards.md §5)."""

from __future__ import annotations

from prometheus_client import Counter, Histogram

EMBED_LATENCY = Histogram(
    "embed_latency_seconds",
    "Latency of /internal/v1/embed batches",
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5),
)

EMBED_REQUESTS = Counter(
    "embed_requests_total",
    "Completed embed batches",
)

RETRIEVAL_LATENCY = Histogram(
    "retrieval_latency_seconds",
    "Latency of /internal/v1/retrieval/search calls",
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5),
)

RETRIEVAL_MODE = Counter(
    "retrieval_mode_total",
    "Retrieval outcomes by mode (architecture.md §4 degradation ladder)",
    ["mode"],
)

INGEST_CHUNKS = Counter(
    "ingest_chunks_total",
    "Chunks processed by ingest runs",
    ["outcome"],
)

RUL_LATENCY = Histogram(
    "rul_predict_latency_seconds",
    "Latency of RUL predictions (architecture.md §7)",
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5),
)

RUL_REQUESTS = Counter(
    "rul_predict_requests_total",
    "Completed RUL predictions (units)",
)
