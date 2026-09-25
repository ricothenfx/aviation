# mro-copilot — Milestone Report: F2 (Corpus, Ingestion & Hybrid Retrieval)

| Field | Value |
|---|---|
| Milestone | F2 per `docs/04-projects/mro-copilot/milestones.md` §F2 |
| Status | **Complete** — Definition of Done met (evidence below) |
| Scope guard | Stack unchanged (D-03/ADR-0010/ADR-0012); no PRD OUT-OF-SCOPE item built |
| Commits | `feat(mro)` conventional commits, `mro` scope, pushed to `origin/main` |
| CI | All GitHub Actions workflows green on `origin/main` (mro unit + python + compose) |

## What shipped

1. **Synthetic NX-320 corpus** (PRD F-1/FR-4, data-model.md §4): 62 committed
   Markdown documents under `apps/mro-copilot/seed/manuals/` — 41 AMM task
   cards, 10 TSM fault-isolation tasks, 5 IPC part-list figures, 6 SB files
   including an **SB-29-002 Rev 01 → Rev 02 supersession pair**. Produced by a
   deterministic seeded generator (`seed/corpus/generate.ts`,
   `pnpm --filter mro-copilot corpus:generate`) that cleans and regenerates the
   directory; the committed Markdown is the ingestion source of truth, so
   reviewers diff corpus changes in git and the FR-5 idempotency invariant is
   portable across environments (uuid5 manual identity + sha256 chunk hashes).
2. **Ingest pipeline** (FR-5/FR-6, data-model.md §5/§7):
   `python -m mro_ai.ingest` inside ai-service plus `POST /internal/v1/ingest`
   (same code path). Chunker honours the §5 rules — atomic task/figure/section
   units, 200–450 token target band with a 500 hard cap, NOTE/CAUTION/WARNING
   lines never split from their parent step, breadcrumb-overlap repeats instead
   of content duplication, fictional page markers → chunk pages. Embeds with
   the deterministic mock provider, classifies new/changed/unchanged/removed
   by content hash, and writes in a **single transaction** (upsert manuals,
   delete stale hashes, insert chunks, apply supersession, record
   `ingest_runs` evidence). Embedding failure aborts before any write.
   Concurrency is guarded by a session advisory lock → `409
   INGEST_IN_PROGRESS`.
3. **Hybrid retrieval** (ADR-0010 §4, FR-7/FR-8): `mro_ai/retrieval.py` runs
   ONE SQL statement fusing pgvector cosine top-20 (HNSW index) with
   `ts_rank_cd` top-20 (GIN index) via reciprocal rank fusion (k = 60); shared
   metadata filters apply to both legs before fusion; default scope is active
   revisions (explicit `revision` filter bypasses the status scope, so
   superseded history stays queryable). Degradation ladder: hybrid →
   **lexical** when the embedding provider is unavailable, DB-down → 503 error
   shape. The response names its mode so the API and UI can flag degradation
   honestly.
4. **REST layer** (api-contracts.md §1): `GET /api/v1/manuals` (list + TOC
   facets + cursor pagination), `/api/v1/manuals/{id}` (metadata + section
   tree derived from chunk section paths), `/api/v1/manuals/{id}/chunks/
   {chunkId}` (full provenance: breadcrumb, fictional page, revision, effective
   date, prev/next) and `GET /api/v1/search` (proxy to the ai-service with
   zod-validated responses). All handlers enforce viewer+ server-side
   (architecture.md §5).
5. **UI** (ui-design-system.md §5/§7/§9): manual library browser (`/manuals`)
   with doc-type/ATA TOC tree, section navigation with page references and a
   chunk reader carrying breadcrumb/page/revision/effective-date + prev/next;
   search screen (`/search`) with doc-type/ATA/revision filters, safe
   ts_headline highlight rendering (no raw HTML), retrieval-mode honesty
   (lexical-only flagged as degraded), loading/empty/error states with retry +
   requestId, LiveDot freshness cue, persistent simulated-data footer.
   Screenshots: `assets/f2-manuals-chunk.png`, `assets/f2-search-hybrid.png`.
6. **Eval** (FR-19, data-model.md §9): `seed/eval/golden-qa.json` (52
   hand-written cases, every expected citation programmatically validated
   against the corpus manifest) and `seed/eval/refusal-set.json` (22 cases:
   fictional other aircraft types, nonexistent procedures, fleet-status
   questions — no real companies, data-ethics.md). `pnpm eval:mro` drives the
   **public** `/api/v1/search` as a seeded user and writes JSON+MD reports to
   `eval-reports/`. The refusal set is scored by the full eval from F3 (ask
   flow lands there); retrieval mode reports it as loaded fixture context.
7. **Benchmarks & CI**: `pnpm bench:mro-search` (300-sample warm benchmark)
   gates search p95 < 300 ms; the mro.yml compose job now runs the integration
   suite, the eval gate and the latency gate against the booted stack.

## Definition of Done — evidence

| DoD item (milestones.md §F2) | Evidence |
|---|---|
| Ingest idempotency test in CI (FR-5) | `tests-integration/ingest-idempotency.test.ts` — re-ingest via `/internal/v1/ingest`, asserts identical chunk-hash set, vector count and corpus digest; runs in the mro.yml compose job. Python-side determinism: `tests/test_corpus_chunker.py` |
| Corpus committed and ingested: ≥ 40 docs, ≥ 600 chunks, every chunk resolvable (spot-check test) | 62 docs / 630 chunks; `tests-integration/corpus.test.ts` asserts counts, breadcrumb-prefixed content, page/revision resolvability, warnings glued to steps, superseded SB resolvable |
| Retrieval eval (offline, mock): recall@5 ≥ 0.85 + MRR, report committed | **recall@5 = 0.9231, hit-rate@5 = 0.9231, MRR = 0.8458** over 52 golden cases via public `/api/v1/search`; reports at `eval-reports/retrieval-v1.{json,md}`; CLI exits non-zero below the gate |
| Degradation ladder test: provider killed ⇒ `mode: "lexical"` within contract (FR-7) | `tests-integration/degradation-ladder.test.ts` boots a REAL degraded ai-service container (`LLM_PROVIDER=off`) on the compose network: `/readyz` reports provider down, embed fails loudly, search returns `mode:"lexical"` with full contract-shaped hits. Unit side: `tests/test_search_route.py` |
| Contract + RBAC tests for `/api/v1/manuals/*` and `/api/v1/search` | `tests-integration/search-contract.test.ts` (401 envelope, per-role 200s, validation/clamp 400s, docType filter on the wire, superseded excluded from default scope, detail/chunk shapes, 404s). Cross-runtime: zod + pydantic both parse `tests/fixtures/retrieval_contract.json` |
| Search p95 < 300 ms at reference scale on the compose stack, measured + logged | **p95 = 176.3 ms, p50 = 45.3 ms, p99 = 286.6 ms** over 300 sequential end-to-end searches (0 errors) against the compose stack on a loaded 8-core host; `eval-reports/search-latency.json`; gate step in mro.yml |
| Manual browser: TOC nav, chunk view w/ breadcrumb + page + revision, all mandatory states (ui-design-system §7) | `/manuals` + `/search` client screens; loading skeletons, empty states (incl. "library empty — run ingest" copy), error states with retry + requestId, LiveDot freshness cue; screenshots committed under `assets/` |

## Document sections that guided major choices

- `milestones.md` §F2 scope + DoD; §Handoff Protocol (report → push every step → green workflows).
- `data-model.md` §4 (corpus layout + hand-authored Markdown source of truth), §5 (chunking rules: atomic units, 200–450/500 sizing, warning gluing, breadcrumb-overlap, hash formula), §2 (ingest_runs evidence table — added via forward-only migration `0001`), §9 (golden-QA/refusal fixture shape).
- `architecture.md` §4 (retrieval pipeline + degradation ladder), §5 (middleware guards pages, RBAC in handlers), §6 (embed-failure aborts pre-write), §7 (one log line per RAG stage, metrics).
- `api-contracts.md` §1 (endpoint inventory, response fields, eval CLI drives public endpoints), §2 (error envelope), §3 (internal `/internal/v1/*` shapes, bearer), §4 (idempotency notes).
- `PRD.md` FR-4..FR-8, FR-19/FR-20, US-1/US-2; NFRs (p95 budget).
- ADR-0010 (single-engine hybrid + RRF, HNSW, revision scope), ADR-0012 (ai-service owns ingest/retrieval; TS app orchestrates; bearer).
- `ui-design-system.md` §5/§7/§9 (states, safety of highlight rendering, footer).
- `engineering-standards.md` §4 (cursor pagination; offset tolerated for small reference lists — opaque cursor used), §5 (structured logs/metrics), §7 (conventional commits), §8 (migration discipline, seed location).
- AGENTS.md §3 (truth hierarchy, quality gates, synthetic-data honesty), §5 (commands — added `eval:mro`, `bench:mro-search`, `corpus:generate`).

## Deviations & honest notes

1. **Corpus authored via a deterministic generator.** data-model.md §4 says
   "Markdown source of truth is the committed corpus"; the PRD calls the
   corpus "hand-written synthetic". The committed Markdown IS the source of
   truth for ingestion; the committed generator is the authoring tool that
   produced it (seeded PRNG, hand-authored phrase banks, fictional facts).
   Rationale: 62 docs / 630 chunks of plausible maintenance prose could not be
   authored by hand in-milestone; procedural assembly keeps every chunk
   traceable and the corpus byte-reproducible. Flagging explicitly per the
   Handoff Protocol; happy to convert to fully hand-authored files if the user
   prefers.
2. **`mro-web` now serves a production Next build** in the compose profile
   (build + seed + `next start`). Dev-mode per-request overhead (~130 ms p50,
   ~700 ms p95 tail on a loaded host) is not the product shape and made the
   FR-8 gate measure the wrong thing. Clean-clone UX is unchanged except a
   slower first boot; CI wait timeout raised to 900 s. The F1 "dev servers"
   behaviour remains available via `pnpm --filter mro-copilot dev` on the host.
3. **Retrieval connection pooling** (one psycopg connection per service,
   serialized by a lock, reconnect-on-error): per-request TCP+auth handshakes
   dominated the latency budget at this scale. No new dependency added
   (`psycopg_pool` deliberately not introduced without an ADR).
4. **`POST /api/v1/admin/ingest` (app-level, api-contracts.md §1) is NOT built
   in F2.** The milestone scope lists ingest CLI + internal endpoint + eval
   CLI only, and its DoD names only manuals/search contract tests; the admin
   trigger lands with the reviewer-facing UI that needs it (F3 review flow /
   F5 ship gate). Internal endpoint + CLI exist and are CI-tested. Flagged as
   a tracked gap, not silently dropped.
5. **Refusal-set is authored but not scored in F2** — refusal accuracy needs
   the ask flow (F3); the F2 eval reports it as fixture context. Consistent
   with the milestone's "eval CLI retrieval mode".
6. **Host quirk worked around**: the shared dev host ran at load ~10 with the
   turnaround stack co-resident; final gate numbers were measured against the
   production-shaped compose stack anyway (see DoD table).
7. **Mock-embedder semantics are weak by design** (hashed char n-grams,
   ADR-0012) — semantic recall is mostly carried by the lexical leg today; the
   hybrid SQL and eval harness are the deliverable, and swapping the provider
   later re-balances the legs without contract changes.

## Verification log (local, pre-push)

- `pnpm lint` / `pnpm typecheck` (strict) / `pnpm test` (unit, 4+ workspaces): clean.
- Python gate in the pinned image (ruff · ruff format · mypy strict · pytest): 42 passed.
- `pnpm --filter mro-copilot test:integration`: 46 passed (7 files) against the compose stack.
- `pnpm eval:mro`: recall@5 0.9231 (gate ≥ 0.85) PASS — reports committed.
- `pnpm bench:mro-search`: p95 176.3 ms (gate < 300 ms) PASS — report committed.
- GitHub Actions: pushed to `origin/main`; mro.yml unit + python + compose jobs green (link in final handoff note).
