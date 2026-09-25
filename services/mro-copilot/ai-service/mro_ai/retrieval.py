"""Hybrid retrieval — pgvector + tsvector fused by RRF (ADR-0010, §4).

Single PostgreSQL round-trip per search: one statement runs both legs
(vector cosine top-20 over the HNSW index, lexical ts_rank_cd top-20 over the
GIN index) and fuses them with reciprocal rank fusion (k = 60). Filters apply
to BOTH legs before fusion.

Degradation ladder (architecture.md §4):
  hybrid  — embedding provider available (default);
  lexical — embedding provider unavailable/failed at query time; the response
            names the mode so the app and UI can flag it honestly (FR-7);
  error   — database unreachable; the caller sees an exception (503 shape).
"""

from __future__ import annotations

import functools
import json
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import anyio
import psycopg

from mro_ai.gateway import Gateway, ProviderUnavailableError

RRF_K = 60
LEG_TOP_K = 20

logger = logging.getLogger("mro_ai.retrieval")


@dataclass(frozen=True)
class SearchFilters:
    """Metadata filters applied to both legs before fusion (api-contracts §3)."""

    doc_types: list[str] | None = None
    ata_chapters: list[str] | None = None
    revision: str | None = None


@dataclass(frozen=True)
class SearchHit:
    """One fused result (SearchHit in api-contracts.md §1)."""

    chunk_id: str
    manual_id: str
    doc_type: str
    task_no: str
    ata_chapter: str
    section_path: str
    page: int
    revision: str
    effective_date: str
    snippet: str
    score: float


@dataclass(frozen=True)
class SearchResult:
    """Search outcome; `mode` flags degraded retrieval (FR-7)."""

    mode: str  # "hybrid" | "lexical"
    hits: list[SearchHit]
    latency_ms: int
    embed_ms: int = 0


ConnectionFactory = Callable[[str], psycopg.Connection[tuple[Any, ...]]]


def default_connection_factory(database_url: str) -> psycopg.Connection[tuple[Any, ...]]:
    return psycopg.connect(database_url, connect_timeout=3)


class RetrievalService:
    """Owns retrieval SQL; keeps one pooled connection (serialized by a lock).

    Latency budget note (PRD FR-8): per-request TCP+auth handshakes dominate
    at this corpus scale, so the connection is pooled. psycopg3 connections
    are safe under serialized cross-thread use; a broken connection is closed
    and the error raised (caller maps DB-down to the 503 error state).
    """

    def __init__(
        self,
        database_url: str,
        gateway: Gateway | None,
        connection_factory: ConnectionFactory | None = None,
    ) -> None:
        self._database_url = database_url
        self._gateway = gateway
        self._connection_factory = connection_factory or default_connection_factory
        self._lock = threading.Lock()
        self._conn: psycopg.Connection[tuple[Any, ...]] | None = None

    async def search(
        self,
        query: str,
        k: int,
        filters: SearchFilters | None = None,
    ) -> SearchResult:
        started = time.monotonic()
        embed_ms = 0
        query_vector: list[float] | None = None
        if self._gateway is not None:
            embed_started = time.monotonic()
            try:
                result = await self._gateway.embed(query)
                query_vector = result.vector
            except ProviderUnavailableError:
                # Degradation ladder: hybrid → lexical (provider down).
                query_vector = None
            embed_ms = int((time.monotonic() - embed_started) * 1000)

        mode = "hybrid" if query_vector is not None else "lexical"
        sql_started = time.monotonic()
        # psycopg is sync — keep the event loop free (engineering-standards §5).
        hits = await anyio.to_thread.run_sync(
            functools.partial(self._execute_pooled, query, query_vector, k, filters)
        )
        sql_ms = int((time.monotonic() - sql_started) * 1000)
        latency_ms = int((time.monotonic() - started) * 1000)
        logger.info(
            "search %s",
            json.dumps(
                {
                    "level": "info",
                    "module": "retrieval",
                    "msg": "search",
                    "mode": mode,
                    "k": k,
                    "results": len(hits),
                    "latency_ms": latency_ms,
                    "embed_ms": embed_ms,
                    "sql_ms": sql_ms,
                }
            ),
        )
        return SearchResult(mode=mode, hits=hits, latency_ms=latency_ms, embed_ms=embed_ms)

    def _execute_pooled(
        self,
        query: str,
        query_vector: list[float] | None,
        k: int,
        filters: SearchFilters | None,
    ) -> list[SearchHit]:
        with self._lock:
            if self._conn is None or self._conn.closed:
                self._conn = self._connection_factory(self._database_url)
            try:
                statement, params = build_search_sql(query, query_vector, k, filters)
                rows = self._conn.execute(statement, params).fetchall() or []
            except psycopg.Error:
                # Broken connection (DB restart, network): drop it; next call
                # reconnects. The error itself surfaces to the caller.
                self._conn.close()
                self._conn = None
                raise
        return [row_to_hit(row) for row in rows]


def build_search_sql(
    query: str,
    query_vector: list[float] | None,
    k: int,
    filters: SearchFilters | None,
) -> tuple[str, dict[str, object]]:
    """Compose the single-round-trip hybrid (or degraded lexical) statement."""
    f = filters or SearchFilters()
    conditions = []
    if f.revision:
        # Explicit revision applicability (api-contracts §1) — matches that
        # revision regardless of active/superseded status.
        conditions.append("m.revision = %(revision)s")
    else:
        # Default: active revisions only; superseded content is searchable
        # explicitly by revision, never mixed into default results (FR-6).
        conditions.append("m.status = 'active'")
    if f.doc_types:
        conditions.append("m.doc_type::text = any(%(doc_types)s)")
    if f.ata_chapters:
        conditions.append("m.ata_chapter = any(%(ata_chapters)s)")
    where = "\n          and ".join(conditions)

    vector_leg = ""
    if query_vector is not None:
        params_vector = "[" + ",".join(repr(v) for v in query_vector) + "]"
        vector_leg = f"""
        vec as (
            select c.id as chunk_id,
                   row_number() over (order by c.embedding <=> %(embedding)s::vector) as rank
            from chunks c
            join manuals m on m.id = c.manual_id
            where c.embedding is not null
              and {where}
            order by c.embedding <=> %(embedding)s::vector
            limit %(leg_k)s
        ),"""
        fused = """
        fused as (
            select chunk_id, 1.0::float8 / (%(rrf_k)s + rank) as score from vec
            union all
            select chunk_id, 1.0::float8 / (%(rrf_k)s + rank) as score from lex
        )"""
    else:
        params_vector = ""
        fused = """
        fused as (
            select chunk_id, 1.0::float8 / (%(rrf_k)s + rank) as score from lex
        )"""

    statement = f"""
    with q as (
        select websearch_to_tsquery('english', %(query)s) as tsq
    ),{vector_leg}
    lex as (
        select c.id as chunk_id,
               row_number() over (
                   order by ts_rank_cd(c.tsv, q.tsq) desc, c.id
               ) as rank
        from chunks c
        join manuals m on m.id = c.manual_id
        cross join q
        where c.tsv @@ q.tsq
          and {where}
        order by ts_rank_cd(c.tsv, q.tsq) desc, c.id
        limit %(leg_k)s
    ),{fused}
    select f.chunk_id,
           sum(f.score) as score,
           m.id as manual_id,
           m.doc_type::text as doc_type,
           coalesce(m.task_no, '') as task_no,
           m.ata_chapter,
           c.section_path,
           c.page,
           m.revision,
           m.effective_date::text as effective_date,
           ts_headline(
               'english', c.content, (select tsq from q),
               'StartSel=[[ StopSel=]] MaxWords=42 MinWords=18 MaxFragments=2'
               ' FragmentDelimiter=…'
           ) as snippet
    from fused f
    join chunks c on c.id = f.chunk_id
    join manuals m on m.id = c.manual_id
    group by f.chunk_id, m.id, m.doc_type, m.task_no, m.ata_chapter,
             c.section_path, c.page, m.revision, m.effective_date, c.content
    order by score desc
    limit %(k)s
    """

    params: dict[str, object] = {
        "query": query,
        "k": k,
        "leg_k": LEG_TOP_K,
        "rrf_k": RRF_K,
        "doc_types": f.doc_types,
        "ata_chapters": f.ata_chapters,
        "revision": f.revision,
    }
    if query_vector is not None:
        params["embedding"] = params_vector
    return statement, params


def row_to_hit(row: tuple[Any, ...]) -> SearchHit:
    """Map one SQL row to a SearchHit."""
    return SearchHit(
        chunk_id=str(row[0]),
        manual_id=str(row[2]),
        doc_type=str(row[3]),
        task_no=str(row[4]),
        ata_chapter=str(row[5]),
        section_path=str(row[6]),
        page=int(row[7]),
        revision=str(row[8]),
        effective_date=str(row[9]),
        snippet=str(row[10]),
        score=float(row[1]),
    )
