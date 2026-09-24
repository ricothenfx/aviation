# MRO Copilot — Milestones

| Field | Value |
|---|---|
| Status | Approved — execution order binding (D-05; user approval 2026-09-24) |
| Rule | One milestone per agent run. DoD evidence linked in the milestone report. No jumping ahead. |

## F0 — Documentation (DONE 2026-09-24)
PRD/architecture/data-model/api-contracts/milestones authored and user-approved;
ADR-0010/0011/0012 + decision-log D-16…D-18 accepted. ✅

## F1 — Scaffold & Skeleton
**Scope:** `apps/mro-copilot` (Next.js) + `services/mro-copilot/ai-service` (FastAPI) per
ADR-0012; compose profile `mro` (web :3003, ai-service :4103 loopback, shared infra
Postgres, database `mro_copilot`); pgvector + schema migrations (data-model.md);
auth module re-implemented per D-09 (seeded users, roles `viewer/engineer/reviewer`); app
shell with nav + all mandatory states (ui-design-system §7); ai-service gateway port with
deterministic mock embedder (ADR-0012) + `/healthz` `/readyz` `/metrics`; path-filtered CI.

**DoD:**
- [ ] Clean clone: `pnpm install && docker compose --profile mro up -d` then dev servers serve login + app shell (README-documented, from-scratch run recorded)
- [ ] CI green: lint + typecheck + unit + build for both runtimes (zero warnings, strict TS)
- [ ] Login as seeded user per role works; role ladder enforced server-side (RBAC test matrix viewer/engineer/reviewer)
- [ ] Migration test: `vector` extension + HNSW index on `chunks.embedding` + GIN on `chunks.tsv` exist after `db:migrate`
- [ ] Contract test: `/internal/v1/embed` deterministic (same text ⇒ same 384-dim vector), pydantic ↔ zod field parity for shared shapes
- [ ] `/healthz` + `/readyz` on both services; readyz reports DB, pgvector, artifact, provider dependencies
- [ ] ADR compliance: no library outside tech-stack.md (+ ADR-0010/0011 sanctioned Python ML deps)

## F2 — Corpus, Ingestion & Hybrid Retrieval
**Scope:** author NX-320 synthetic corpus (≥ 40 docs: AMM task cards, IPC figures, TSM
fault isolation, SBs — data-model.md §4, all fictional, visibly labeled); ingest pipeline
(chunking per data-model.md §5 → mock embed → upsert, idempotent); hybrid retrieval
(pgvector + tsvector RRF, filters, degradation ladder); manual browser + search UI;
eval fixtures (golden-qa ≥ 50, refusal-set ≥ 20) + eval CLI retrieval mode.

**DoD:**
- [ ] Ingest idempotency test: re-ingesting the unchanged corpus yields identical chunk-hash set + vector count (FR-5) — CI
- [ ] Corpus committed and ingested: ≥ 40 docs, ≥ 600 chunks, every chunk resolvable to doc + section + fictional page + revision (spot-check test)
- [ ] Retrieval eval (offline, mock): **recall@5 ≥ 0.85** and MRR on golden set; report (JSON+MD) committed via `pnpm eval:mro`
- [ ] Degradation ladder test: with embedding provider killed, search returns `mode: "lexical"` and stays within contract (FR-7/architecture §4)
- [ ] Contract + RBAC tests for `/api/v1/manuals/*` and `/api/v1/search`
- [ ] Search p95 < 300 ms at reference scale on compose stack — measured, logged in report
- [ ] Manual browser shows TOC nav, chunk view with breadcrumb/page/revision, persistent simulated-data footer; loading/empty/error/live states present (ui-design-system §7 screenshots)

## F3 — RAG Copilot, Guardrails & Sign-off
**Scope:** ask flow end-to-end (retrieval → prompt assembly → `packages/llm-gateway` →
guardrail post-checks → persisted draft); refuse-when-ungrounded (threshold + citation
validity); `source`/`provider` honesty + extractive fallback; answer lifecycle
`draft → approved | rejected` with append-only audit + verified-answer library; review
queue UI; eval full-mode gates wired into CI; ask panel + review queue design polish.

**DoD:**
- [ ] Refusal tests: below-threshold question ⇒ `status: refused` with reason and **no** answer/citations fields; refusal-set accuracy = **100%** in CI eval
- [ ] Citation-validity tests: hallucinated citation stripped; answer with zero valid citations ⇒ refusal — invariant holds at **100%** (FR-11)
- [ ] Full eval gates green in CI: recall@5 ≥ 0.85 · refusal 100% · citation validity 100% · grounded answer rate ≥ 80% (golden set, mock provider); report committed
- [ ] Source-labeling tests: mock LLM ⇒ `source: "llm", provider: "mock"`; provider unavailable ⇒ extractive fallback labeled `source: "extractive"`; UI badge renders both (FR-12)
- [ ] Sign-off integration tests: approve/reject transitions, mandatory note on reject, **self-approval blocked** (`SELF_APPROVAL_FORBIDDEN`), audit events append-only
- [ ] Ask p95 < 2.5 s with mock provider on compose stack — measured, logged
- [ ] E2E (Playwright): login → ask → open citation into manual browser at the cited chunk → reviewer approves → answer appears in verified library
- [ ] Design-system review §5/§7/§8 passes for ask panel + review queue (screenshots in report)

## F4 — Engine Health (C-MAPSS → RUL)
**Scope:** C-MAPSS seed (pinned download + sha256; committed synthetic 3-unit sample for
CI); `sensor_readings` hypertable + deterministic time mapping (data-model.md §8); GBM
training CLI (ADR-0011, piecewise-RUL 125, seeded) → versioned artifact + `metrics.json`;
predict/score-fleet endpoints with provenance; maintenance-window alert engine + lifecycle;
fleet dashboard UI (tiles, trend chart, alert list, C-MAPSS citation).

**DoD:**
- [ ] `download.sh` verifies pinned sha256 (test with tampered fixture ⇒ hard fail); CI path uses committed sample, clearly labeled synthetic
- [ ] Training reproducibility test: same seed ⇒ identical artifact sha256 (CI)
- [ ] `metrics.json` committed: FD001 test **RMSE ≤ 24 cycles** + NASA score, tabled next to published GBM/LSTM baselines with honest commentary (D-07)
- [ ] Contract tests: every RUL response carries `modelVersion` + `modelSha256`; `MODEL_NOT_LOADED` (503) when artifact absent; `/readyz` reflects it
- [ ] Alert integration test: fixture unit crossing threshold produces alert with `leadCycles ≥ 5`; ack/resolve lifecycle + RBAC matrix pass
- [ ] Honesty case: unit with insufficient history returns `latestRul: null` and dashboard renders "—" (never 0; D-15 precedent)
- [ ] Fleet dashboard: tiles + trend chart with labeled axes/units + alert list; loading/empty/error/live states; simulated-data footer + C-MAPSS citation visible
- [ ] Design-system review §5/§7/§8 passes for engine-health screens (screenshots in report)

## F5 — Evidence & Ship
**Scope:** k6 latency/load evidence (search + ask); final consolidated eval report; README
landing (problem→solution, architecture diagram, JD mapping table Req 7133/7167, honest
data/simulation section, model card summary); demo script + 90 s walkthrough video; live
demo deploy mirroring D-12 topology; traceability-matrix §2 populated; market-research §5
re-verification.

**DoD:**
- [ ] Load report (honest, committed): search p95 < 300 ms at 100 VU; ask p95 < 2.5 s at 25 VU (mock provider) — failures/degradations documented, scripts under `scripts/`
- [ ] Final eval report: all F3 gates re-run at final corpus/fixture versions; model metrics alongside
- [ ] README complete: double-audience narrative, ADR-linked trade-off story (pgvector-not-vector-DB, GBM-not-LSTM, two-runtime split), "what is simulated" section
- [ ] Live demo URL serving `/healthz` + seeded login + one grounded ask with citations; fresh 90 s video (demo-script.md)
- [ ] `docs/00-context/traceability-matrix.md` §2: every row has feature, code path, tests (usage protocol §3)
- [ ] `docs/00-context/market-research.md` §5 re-verification run; snapshot date updated
- [ ] All PRD in-scope features F-1…F-7 demonstrable in one continuous run

## Handoff Protocol (every milestone)
1. Milestone report: what shipped, DoD checklist with evidence links, doc sections relied upon (AGENTS.md §3).
2. Deviations: any spec mismatch found → STOP, report, propose doc fix. Docs win over code until the user says otherwise.
3. Next milestone starts only on the user's go.
4. Commit and push every completed step/milestone to `origin/main` (conventional commits, `mro` scope) — standing user instruction 2026-09-24.
