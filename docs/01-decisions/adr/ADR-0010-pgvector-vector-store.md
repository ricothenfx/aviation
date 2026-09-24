# ADR-0010: pgvector in the Existing PostgreSQL Cluster as the Vector Store

| Field | Value |
|---|---|
| Status | Accepted (user approval 2026-09-24, closing mro-copilot F0) |
| Date | 2026-09-24 |
| Supersedes | — |
| Related | D-03, D-08, ADR-0002, ADR-0012, tech-stack.md §1/§3, mro-copilot data-model.md |

## Context

mro-copilot needs semantic search over a synthetic maintenance-manual corpus (chunk
embeddings, nearest-neighbor query at ask time). The corpus at reference scale is small:
~40 authored documents → ~600–900 chunks (data-model.md §6). The locked stack allows one
PostgreSQL 16 cluster (timescaledb-HA image) with per-project databases and prohibits new
databases without an ADR (tech-stack.md §3).

The PRD skeleton already anticipated "pgvector in the existing PostgreSQL cluster"; this
ADR makes that binding and records the alternatives.

## Decision

Vector storage and similarity search use the **`pgvector` extension inside the existing
PostgreSQL 16 cluster**, in the project's own database (`mro_copilot`):

- `CREATE EXTENSION vector` applied by a drizzle-kit migration (versioned like any schema change).
- `vector(384)` column with an **HNSW index** (cosine distance) on chunks.
- **Hybrid retrieval**: pgvector cosine top-k fused with PostgreSQL full-text (`tsvector`, GIN) ranking via reciprocal rank fusion (RRF) — single-engine, single-round-trip retrieval (architecture.md §4).
- No separate vector database, no separate embedding index file format.

## Alternatives considered

1. **Dedicated vector DB (Qdrant, Weaviate, Pinecone)** — rejected: new infrastructure
   outside the locked stack (needs ADR-level exception), an extra container to operate for
   a sub-1k-chunk corpus, and a second source of truth to keep consistent with the chunk
   store. Ops overhead cannot be justified at portfolio scale (same reasoning shape as
   ADR-0002/D-03).
2. **In-process index (FAISS/hnswlib files on disk)** — rejected: index lifecycle drifts
   from chunk lifecycle (no transactional re-ingest), no SQL filterable metadata (ATA
   chapter, doc type, revision), and a non-versioned binary artifact in the repo.
3. **pgvector `ivfflat`** — rejected in favor of HNSW: better recall/recall-speed trade-off
   at this scale without requiring training runs on re-ingest.

## Consequences

- (+) One engine, one migration tool, one backup story; re-ingest and index updates are
  transactional with chunk metadata.
- (+) Hybrid (lexical + semantic) retrieval fits in one SQL query — a defensible
  production pattern for small-to-mid corpora, and an honest interview answer about
  when a vector DB is *not* needed.
- (+) The AWS mapping gains no new component (RDS PostgreSQL supports pgvector).
- (−) pgvector must stay version-compatible with the timescaledb-HA image; the extension
  version is pinned in the compose file and recorded at F1.
- (−) Scale ceiling: this design is not a fleet-scale embedding store (~10M+ chunks would
  force the dedicated-DB conversation — documented limitation, revisit via new ADR).
