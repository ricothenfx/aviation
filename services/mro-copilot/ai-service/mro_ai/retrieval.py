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

import contextlib
import functools
import json
import logging
import threading
import time
from collections.abc import Callable, Iterator
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
    """One fused result (SearchHit in api-contracts.md §1).

    ``vector_score`` / ``term_coverage`` are grounding-quality signals (F3):
    cosine similarity of the query embedding against this chunk (null in
    lexical mode) and the fraction of query lexemes present in the chunk's
    tsv. The app composes its guardrail threshold from them (architecture
    §3); they are additive fields, never used for ranking.
    """

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
    vector_score: float | None = None
    term_coverage: float = 0.0


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
    """Owns retrieval SQL; draws connections from a small bounded pool.

    F2 kept one pooled connection behind a lock — right for single-client
    latency, but it serializes every search (and every ask, which retrieves
    first), capping throughput at 1000/per-request-ms and making the F5 gate
    (search p95 < 300 ms @ 100 VU) structurally unreachable. ADR-0013 replaced
    it with an in-module bounded pool (capacity 8, psycopg stdlib only): idle
    connections are reused, the pool grows to capacity on demand, and burst
    demand beyond capacity uses transient connections that are closed on
    return — concurrency is never queued behind a lock. Broken connections are
    closed and never reused; the next checkout reconnects.
    """

    def __init__(
        self,
        database_url: str,
        gateway: Gateway | None,
        connection_factory: ConnectionFactory | None = None,
        pool_capacity: int = 8,
    ) -> None:
        self._database_url = database_url
        self._gateway = gateway
        self._pool = _ConnectionPool(
            connection_factory or default_connection_factory,
            database_url,
            capacity=pool_capacity,
        )

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
        with self._pool.checkout() as conn:
            statement, params = build_search_sql(query, query_vector, k, filters)
            rows = conn.execute(statement, params).fetchall() or []
        return [row_to_hit(row) for row in rows]


class _ConnectionPool:
    """Fixed-capacity connection pool built on psycopg stdlib only (ADR-0013).

    - checkout hands out any idle connection; when none is free and the pool
      still has capacity, a new connection is created and pooled on return;
    - demand beyond capacity creates a TRANSIENT connection, closed on return
      (burst concurrency is never queued behind a lock);
    - a broken connection is closed and never reused; the next checkout
      reconnects (pool slot accounting drops with it).
    """

    def __init__(
        self,
        factory: ConnectionFactory,
        database_url: str,
        capacity: int = 8,
    ) -> None:
        self._factory = factory
        self._database_url = database_url
        self._capacity = capacity
        self._lock = threading.Lock()
        self._idle: list[psycopg.Connection[tuple[Any, ...]]] = []
        self._live = 0  # pooled connections currently created (idle + checked out)

    @contextlib.contextmanager
    def checkout(self) -> Iterator[psycopg.Connection[tuple[Any, ...]]]:
        with self._lock:
            conn = self._idle.pop() if self._idle else None
            pooled = conn is not None or self._live < self._capacity
            if conn is None and pooled:
                self._live += 1
        if conn is None:
            # Not covered by the lock: TCP + auth handshake must not block
            # other checkouts (same reason search runs in a worker thread).
            try:
                conn = self._factory(self._database_url)
            except Exception:
                if pooled:
                    with self._lock:
                        self._live -= 1
                raise

        transient = not pooled
        try:
            yield conn
        except psycopg.Error:
            # Broken connection (DB restart, network): drop it either way; the
            # error itself surfaces to the caller (503 shape, unchanged).
            try:
                conn.close()
            finally:
                with self._lock:
                    if not transient:
                        self._live -= 1
            raise
        else:
            if transient:
                conn.close()
            else:
                with self._lock:
                    self._idle.append(conn)

    def idle_count(self) -> int:
        with self._lock:
            return len(self._idle)


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
    # Grounding-quality signals (F3, additive): cosine of the query embedding
    # against the chunk (hybrid mode only — null when degraded to lexical) and
    # the fraction of query lexemes the chunk's tsv actually contains. The app
    # blends them for its guardrail; they never affect ranking.
    vector_score_expr = (
        "case when c.embedding is null then null"
        " else 1 - (c.embedding <=> %(embedding)s::vector) end"
        if query_vector is not None
        else "null::float8"
    )
    term_coverage_expr = """
        greatest(
            (
                select count(*) from unnest((select lex from q)) as t
                where t = any(tsvector_to_array(c.tsv))
            )::float8 / greatest(cardinality((select lex from q)), 1),
            0.0
        )"""

    statement = f"""
    with q as (
        select websearch_to_tsquery('english', %(query)s) as tsq,
               tsvector_to_array(to_tsvector('english', %(query)s)) as lex
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
            ) as snippet,
            {vector_score_expr} as vector_score,
            {term_coverage_expr} as term_coverage
    from fused f
    join chunks c on c.id = f.chunk_id
    join manuals m on m.id = c.manual_id
    group by f.chunk_id, c.id, m.id, m.doc_type, m.task_no, m.ata_chapter,
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
    vector_score = row[11]
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
        vector_score=float(vector_score) if vector_score is not None else None,
        term_coverage=float(row[12]),
    )
