"""DB dependency checks for /readyz (architecture.md §7).

F1 only needs readiness probes; the hybrid retrieval SQL and ingest connection
management arrive with F2 on top of this module.
"""

from __future__ import annotations

from typing import Any

PGVECTOR_TIMEOUT_S = 5.0


def _connect(database_url: str) -> Any:
    import psycopg

    return psycopg.connect(database_url, connect_timeout=3, autocommit=True)


def check_postgres(database_url: str) -> bool:
    try:
        with _connect(database_url) as conn, conn.cursor() as cur:
            cur.execute("select 1")
            return cur.fetchone() is not None
    except Exception:  # readiness must swallow and report any failure
        return False


def check_pgvector(database_url: str) -> bool:
    try:
        with _connect(database_url) as conn, conn.cursor() as cur:
            cur.execute("select 1 from pg_extension where extname = 'vector' limit 1")
            return cur.fetchone() is not None
    except Exception:
        return False
