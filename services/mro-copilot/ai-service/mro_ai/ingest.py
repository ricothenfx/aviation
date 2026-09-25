"""Idempotent corpus ingestion (PRD FR-5/FR-6, data-model.md §5/§7).

The CLI (`python -m mro_ai.ingest`) and the internal HTTP endpoint
(`/internal/v1/ingest`) share this code path. Behaviour:

1. Parse + chunk the committed Markdown corpus (pure `corpus.py`).
2. Embed only NEW/CHANGED chunk contents via the gateway — unchanged chunks
   keep their stored embedding; embedding failure aborts BEFORE any write
   (architecture.md §6: no half-embedded corpus).
3. One transaction: upsert manuals, delete stale chunk hashes, insert new
   chunks, apply the supersession rule, record the ingest run.
4. Re-running on an unchanged corpus is a no-op: identical chunk-hash set and
   vector count (asserted by the CI idempotency test).

Concurrency guard: a session-level advisory lock; a second concurrent run
raises `IngestInProgressError` (mapped to HTTP 409 INGEST_IN_PROGRESS).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg

from mro_ai.config import load_config
from mro_ai.corpus import Chunk, ManualMeta, corpus_digest, ingest_plan
from mro_ai.gateway import Gateway
from mro_ai.gateway.mock import EMBED_MODEL_ID

INGEST_LOCK_KEY = 932_001


class IngestInProgressError(Exception):
    """Another ingest run holds the advisory lock (HTTP 409 mapping)."""


@dataclass(frozen=True)
class IngestReport:
    """Result payload (api-contracts.md §1 Admin/Ingest + §3)."""

    corpus_digest: str
    embedding_model: str
    manuals_touched: int
    chunks_new: int
    chunks_changed: int
    chunks_unchanged: int
    chunks_removed: int
    duration_ms: int
    status: str = "completed"

    def payload(self) -> dict[str, object]:
        """camelCase wire shape."""
        return {
            "corpusDigest": self.corpus_digest,
            "embeddingModel": self.embedding_model,
            "manualsTouched": self.manuals_touched,
            "chunks": {
                "new": self.chunks_new,
                "changed": self.chunks_changed,
                "unchanged": self.chunks_unchanged,
                "removed": self.chunks_removed,
            },
            "durationMs": self.duration_ms,
            "status": self.status,
        }


def default_corpus_dir() -> Path:
    """Corpus location outside containers (repo layout), env overridable."""
    env = os.environ.get("MRO_CORPUS_DIR")
    if env:
        return Path(env)
    # mro_ai/ingest.py → mro_ai → ai-service → mro-copilot → services → repo
    repo = Path(__file__).resolve().parents[4]
    return repo / "apps" / "mro-copilot" / "seed" / "manuals"


def embed_model_id(gateway: Gateway) -> str:
    """Model id recorded with every ingest run (honest provenance)."""
    if gateway.provider_name == "mock":
        return EMBED_MODEL_ID
    return f"{gateway.provider_name}:live"


def _vector_literal(vector: list[float]) -> str:
    """Round-trip-faithful pgvector text literal ('[a,b,...]')."""
    return "[" + ",".join(repr(v) for v in vector) + "]"


async def run_ingest(
    database_url: str,
    corpus_dir: Path,
    gateway: Gateway,
) -> IngestReport:
    """Execute one idempotent ingest run; returns the report."""
    started = time.monotonic()
    plan = ingest_plan(corpus_dir)
    if not plan:
        raise RuntimeError(f"corpus at {corpus_dir} is empty — refusing to ingest")

    with psycopg.connect(database_url, autocommit=True) as conn:
        locked = conn.execute("select pg_try_advisory_lock(%s)", (INGEST_LOCK_KEY,)).fetchone()
        if locked is None or locked[0] is not True:
            raise IngestInProgressError("another ingest run is in progress")
        try:
            return await _execute(conn, plan, gateway, started)
        finally:
            conn.execute("select pg_advisory_unlock(%s)", (INGEST_LOCK_KEY,))


async def _execute(
    conn: psycopg.Connection[tuple[Any, ...]],
    plan: list[tuple[ManualMeta, list[Chunk]]],
    gateway: Gateway,
    started: float,
) -> IngestReport:
    # --- read existing state -------------------------------------------------
    existing_hashes_by_manual: dict[str, set[str]] = {}
    existing_index_hash: dict[tuple[str, int], str] = {}
    for meta, _chunks in plan:
        manual_key = str(meta.manual_id)
        rows = (
            conn.execute(
                "select chunk_hash, chunk_index from chunks where manual_id = %s",
                (meta.manual_id,),
            ).fetchall()
            or []
        )
        existing_hashes_by_manual[manual_key] = {str(row[0]) for row in rows}
        for row in rows:
            existing_index_hash[(manual_key, int(row[1]))] = str(row[0])

    # --- classify (content-addressed hashes, data-model.md §5) ---------------
    # new   = chunk hash unknown to the DB at a fresh position
    # changed = same (manual, chunk_index) slot but different content hash
    # unchanged = hash already stored (embedding is kept, not recomputed)
    # removed = DB chunk of a touched manual whose hash the corpus no longer has
    to_embed: list[Chunk] = []
    new = changed = unchanged = removed = 0
    for meta, chunks in plan:
        manual_key = str(meta.manual_id)
        known = existing_hashes_by_manual.get(manual_key, set())
        for chunk in chunks:
            if chunk.chunk_hash in known:
                unchanged += 1
                continue
            if (manual_key, chunk.chunk_index) in existing_index_hash:
                changed += 1
            else:
                new += 1
            to_embed.append(chunk)
        removed += len(known - {c.chunk_hash for c in chunks})

    # --- embed BEFORE any write (fail loudly, no half-embedded corpus) ------
    embeddings: dict[str, list[float]] = {}
    for chunk in to_embed:
        result = await gateway.embed(chunk.content)
        embeddings[chunk.chunk_hash] = result.vector

    # --- single transaction --------------------------------------------------
    with conn.transaction():
        touched: set[str] = set()
        for meta, chunks in plan:
            manual_key = str(meta.manual_id)
            touched.add(manual_key)
            conn.execute(
                """
                insert into manuals (id, doc_type, title, ata_chapter, task_no,
                                     revision, effective_date, status, source_path)
                values (%s, %s, %s, %s, %s, %s, %s, 'active', %s)
                on conflict (doc_type, task_no, revision) do update
                  set title = excluded.title,
                      ata_chapter = excluded.ata_chapter,
                      effective_date = excluded.effective_date,
                      source_path = excluded.source_path
                """,
                (
                    meta.manual_id,
                    meta.doc_type,
                    meta.title,
                    meta.ata_chapter,
                    meta.task_no,
                    meta.revision,
                    meta.effective_date,
                    meta.source_path,
                ),
            )

            corpus_hashes = {c.chunk_hash for c in chunks}
            stale = sorted(existing_hashes_by_manual.get(manual_key, set()) - corpus_hashes)
            if stale:
                conn.execute(
                    "delete from chunks where manual_id = %s and chunk_hash = any(%s)",
                    (meta.manual_id, stale),
                )
            for chunk in chunks:
                if chunk.chunk_hash in existing_hashes_by_manual.get(manual_key, set()):
                    continue
                conn.execute(
                    """
                    insert into chunks (manual_id, chunk_hash, section_path, page,
                                        chunk_index, content, token_count, embedding)
                    values (%s, %s, %s, %s, %s, %s, %s, %s::vector)
                    on conflict (chunk_hash) do nothing
                    """,
                    (
                        meta.manual_id,
                        chunk.chunk_hash,
                        chunk.section_path,
                        chunk.page,
                        chunk.chunk_index,
                        chunk.content,
                        chunk.token_count,
                        _vector_literal(embeddings[chunk.chunk_hash]),
                    ),
                )

        _apply_supersession(conn)

        digest = corpus_digest([c for _m, cs in plan for c in cs])
        duration_ms = int((time.monotonic() - started) * 1000)
        report = IngestReport(
            corpus_digest=digest,
            embedding_model=embed_model_id(gateway),
            manuals_touched=len(touched),
            chunks_new=new,
            chunks_changed=changed,
            chunks_unchanged=unchanged,
            chunks_removed=removed,
            duration_ms=duration_ms,
        )
        conn.execute(
            """
            insert into ingest_runs (corpus_digest, embedding_model, manuals_touched,
                                     chunks_new, chunks_changed, chunks_unchanged,
                                     chunks_removed, duration_ms, status, report)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
            """,
            (
                report.corpus_digest,
                report.embedding_model,
                report.manuals_touched,
                report.chunks_new,
                report.chunks_changed,
                report.chunks_unchanged,
                report.chunks_removed,
                report.duration_ms,
                report.status,
                json.dumps(report.payload()),
            ),
        )
    return report


def _apply_supersession(conn: psycopg.Connection[tuple[Any, ...]]) -> None:
    """Flip non-latest revisions to superseded (FR-6: never delete).

    Rank within (doc_type, task_no) by effective_date then revision number;
    the top row is active, all others superseded. Superseded manuals stay
    queryable so existing citations remain resolvable for audit.
    """
    conn.execute(
        """
        with ranked as (
            select id, row_number() over (
                partition by doc_type, task_no
                order by effective_date desc,
                         coalesce(nullif(regexp_replace(revision, '\\D', '', 'g'), '')::int, 0) desc
            ) as rn
            from manuals
            where task_no is not null
        )
        update manuals m
        set status = (case when r.rn = 1 then 'active' else 'superseded' end)::manual_status
        from ranked r
        where m.id = r.id
          and m.status is distinct from
              (case when r.rn = 1 then 'active' else 'superseded' end)::manual_status
        """
    )


# --- CLI (python -m mro_ai.ingest, PRD FR-5) ---------------------------------
# Exit codes: 0 report emitted · 1 loud failure (nothing half-written) ·
# 2 INGEST_IN_PROGRESS (advisory lock held by a concurrent run).


def _cli() -> int:
    from mro_ai.gateway import ProviderUnavailableError

    config = load_config(os.environ)
    try:
        gateway = Gateway.from_env(os.environ)
    except ProviderUnavailableError as err:
        print(
            json.dumps(
                {
                    "level": "error",
                    "module": "ingest",
                    "msg": "provider unavailable",
                    "err": str(err),
                }
            ),
            file=sys.stderr,
        )
        return 1
    report = asyncio.run(run_ingest(config.database_url, default_corpus_dir(), gateway))
    print(
        json.dumps(
            {"level": "info", "module": "ingest", "msg": "ingest completed", **report.payload()}
        )
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(_cli())
    except IngestInProgressError:
        print(
            json.dumps({"level": "error", "module": "ingest", "msg": "ingest_in_progress"}),
            file=sys.stderr,
        )
        sys.exit(2)
    except Exception as err:  # CLI boundary — report any failure loudly, honestly
        print(
            json.dumps(
                {"level": "error", "module": "ingest", "msg": "ingest failed", "err": str(err)}
            ),
            file=sys.stderr,
        )
        sys.exit(1)
