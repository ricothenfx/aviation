# ADR-0013: mro-copilot Retrieval Concurrency — Bounded Connection Pool in the ai-service

| Field | Value |
|---|---|
| Status | Accepted (2026-09-26, mro-copilot F5 load-hardening; evidence in `docs/04-projects/mro-copilot/load-report-f5.md`) |
| Date | 2026-09-26 |
| Supersedes | — (amends the F2 latency-budget note in `mro_ai/retrieval.py` and architecture.md §4's connection note additively) |
| Related | D-03, D-07, D-16, ADR-0010, ADR-0012, tech-stack.md §1, milestones.md §F5, PRD FR-8/FR-13 |

## Context

The F5 load gate (milestones.md §F5 DoD) requires **search p95 < 300 ms at 100 VU** and
**ask p95 < 2.5 s at 25 VU** on the compose stack. The F2 implementation of
`RetrievalService` kept **one pooled PostgreSQL connection serialized by a
`threading.Lock`** — the right call for the F2 single-client reference measurement
(p95 253 ms via `pnpm bench:mro-search`), because it avoids per-request connection
handshakes.

Load evidence (F5, 2026-09-26) shows the cost: every search — and every ask, which
retrieves first — queues behind that single lock, capping service throughput at
`1000 / per-request-ms` requests per second regardless of CPU headroom. At 100 VU the
measured search p95 was ~5.8 s (k6) and single-connection serialization was the
dominant term (host-noise snapshots recorded in the load report). The gate is
unreachable by scheduling alone; the bottleneck is structural.

## Decision

1. `RetrievalService` replaces the single-connection-plus-lock with a **small bounded
   connection pool implemented in-module with psycopg stdlib only** (no new package):
   - capacity 8 connections per process (corpus-scale; PostgreSQL default
     `max_connections` is far above this);
   - checkout takes any idle connection; when the pool is empty and capacity remains,
     a new connection is created and returned to the pool; demand beyond capacity
     creates a **transient connection that is closed on return** — burst concurrency
     is never queued behind a lock;
   - broken connections (`psycopg.Error`) are closed and never reused; the next
     checkout reconnects (unchanged behavior).
2. **RulService is unchanged** — it already opens a per-call connection
   (`_connect(...)`), which is correct at fleet-scoring scale (one bulk round trip).
3. The public interface (`search`, `connection_factory` injection for hermetic tests,
   degradation ladder semantics) is unchanged; SQL is untouched (ADR-0010 statement).
4. `psycopg_pool` (the official companion package) was considered and **rejected**:
   adding a package requires a dependency decision and buys nothing at capacity 8 —
   the in-module pool is ~60 lines, fully typed, and test-covered.

## Alternatives considered

1. **Keep the single connection, report the load gate as failed** — rejected: the gate
   exists to surface exactly this class of defect; reporting a fixable structural
   serialization as an "environmental" failure would be dishonest (D-07) and the fix
   is small, local, and stack-neutral.
2. **Per-request fresh connections everywhere** — rejected: throws away the F2 win for
   the common low-concurrency case and adds 2–5 ms handshake per request under burst;
   the grow-to-capacity pool keeps reuse AND removes the queue.
3. **`psycopg_pool.ConnectionPool`** — see Decision 4.
4. **Async psycopg + rewritten retrieval executor** — rejected: far larger blast radius
   on the serving path for the same throughput gain; not defensible at this corpus
   scale.

## Consequences

- Search and ask throughput scale with CPU up to the pool capacity instead of
  serializing on one connection; the F5 gates become reachable and are re-measured in
  `load-report-f5.md` with before/after numbers.
- Up to 8 idle PostgreSQL connections per ai-service process — negligible for the
  shared compose cluster.
- The F2 "connection handshakes dominate" latency note is superseded by this file;
  `retrieval.py` docstrings updated accordingly (docs win over code, AGENTS.md §3).
- Test impact: hermetic fake-connection tests keep working via lazy pool growth; a new
  test pins pool reuse/concurrency semantics.
