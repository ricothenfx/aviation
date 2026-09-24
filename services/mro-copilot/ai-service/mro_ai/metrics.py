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
