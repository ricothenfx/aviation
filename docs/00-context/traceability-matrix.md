# Traceability Matrix — JD Requirement → Feature → Code → Test

| Field | Value |
|---|---|
| Status | Living document — update at every milestone |
| Rule | No feature without a JD row. No row without evidence once built. |
| Primary JD | CAG Senior Software Engineer (Req 7075) — see target-roles.md §1 |

## 1. CAG Senior Software Engineer Requirements → turnaround-iq

| # | JD requirement | Feature (PRD ref) | Code path | Tests | Status |
|---|---|---|---|---|---|
| 1 | TypeScript production quality | All app code, strict mode | `apps/turnaround-iq`, `packages/*` | typecheck gate | F1 scaffold done — strict enforced in CI |
| 2 | Next.js full-stack apps | Frontend + REST API routes | `apps/turnaround-iq/src/app` | e2e happy path | F1 shell done (login/board/REST auth+board); projections F2 |
| 3 | Tailwind CSS responsive UI | Design system tokens + components | `packages/ui` | visual smoke | F1 tokens + primitives done; screens F2–F4 |
| 4 | Document-based data models | Replan scenario + task config stored as JSONB documents in PostgreSQL (divergence from MongoDB: ADR-0002) | `apps/turnaround-iq/src/db`, `packages/db/src/schema.ts` (jsonb `config`, `replan_scenarios.proposal_diff`) | schema integration tests (`test/integration` golden replay + idempotency) | F2 done |
| 5 | Git workflows | Conventional commits, PR flow, branch strategy | repo-wide | CI gates | F1 done |
| 6 | REST API design/integration | Versioned REST + WS contracts (auth, board, events, scenarios, inject, replans, explanation) | `apps/turnaround-iq/src/app/api/v1`, `packages/contracts`, api-contracts.md | contract zod schemas; integration suites (RBAC matrix, golden replay); e2e board-replan.spec | F1–F4 done |
| 7 | Docker containerisation | Compose profiles (`infra`/`turnaround`/`evidence`); production web image (`next build` + `next start`) validated under load; **live demo deployed** on a single VPS behind Caddy auto-TLS | `infra/compose`, `infra/observability` (ADR-0007), `infra/deploy` (ADR-0006) | compose smoke in CI; ×10 load gate (load-report-f5.md); live deployment evidence (LE certificate, `/healthz`, seeded login, live wss board) | F1 done; live demo at `https://turnaround-iq.aviation.ricothen.com` since 2026-09-24 (ADR-0006) |
| 8 | AuthN/AuthZ, roles | Seeded users, JWT sessions, RBAC (coordinator/supervisor/viewer) | `apps/turnaround-iq/src/lib/auth` | RBAC + JWT unit tests; CI compose login smoke; server-side matrix e2e | F1–F2 done (Cognito-shaped provider, D-09) |
| 9 | AWS integration | AWS service mapping + IaC-ready deploy config (CDK-compatible structure) — tech-stack.md §2 locked: F5 validates structure, not a live AWS deployment | `infra/deploy/` structure + tech-stack.md §2 mapping table | load gate reproducible from committed scripts (load-report-f5.md) | F5 done (structure + evidence; live AWS = future ADR if wanted) |
| 10 | CI/CD, automated testing, logging, monitoring | GitHub Actions pipeline; structured JSON logs; Prometheus + Grafana evidence dashboard; ×10 load gate | `.github/workflows/ci.yml`, `src/lib/api/respond.ts`, `infra/observability/`, `scripts/loadtest/` | pipeline green; k6 gate p95=198 ms < 1 s (load-report-f5.md §2) | F1 pipeline + logs done; metrics/dashboard/load F5 done |
| 11 | Problem discovery → prototyping → production ownership | PRD problem statement + demo script + production-hardening milestone | docs/04-projects/turnaround-iq (PRD, demo-script.md), load-report-f5.md §3–4 | F5 gate; honest findings documented (data-ethics.md §4) | docs + F5 done |

## 2. CAG ML Engineer (Req 7167) + Full Stack GenAI rows (Req 7133) → mro-copilot

Requirement sources: target-roles.md §2 (Req 7167 MLOps rows; Req 7133 GenAI +
AI-app-reliability rows). Feature refs are PRD F-1…F-7 / FR-n; evidence links are the
milestone reports and final eval/load reports under `docs/04-projects/mro-copilot/`.

| # | JD requirement | Feature (PRD ref) | Code path | Tests | Status |
|---|---|---|---|---|---|
| 1 | RAG with grounding/citations (7133/7167) | Hybrid retrieval + manual browser with revision-traceable citations (F-1/F-2, FR-6/FR-7) | `services/mro-copilot/ai-service/mro_ai/retrieval.py` (RRF over HNSW+GIN, ADR-0010), `apps/mro-copilot/src/lib/ai/client.ts`, `src/app/api/v1/manuals`, `src/app/api/v1/search` | `pnpm eval:mro` recall@5 **0.9231** (golden-QA 52); search-contract + corpus integration tests; migration test (HNSW/GIN exist) | F2 done |
| 2 | LLM integration, prompt design (7133) | RAG orchestration: retrieval→prompt assembly→gateway→guardrails (F-3, FR-9); provider-agnostic gateway + deterministic mock (ADR-0003/0012) | `apps/mro-copilot/src/lib/rag/engine.ts`, `packages/llm-gateway`, `services/mro-copilot/ai-service/mro_ai/gateway/` | pydantic↔zod cross-runtime contract fixtures; extractive-fallback integration test (FR-12) | F3 done |
| 3 | Guardrails: grounding, validation (7133) | Refuse-when-ungrounded with calibrated threshold; citation-validity invariant; refusal integrity — no answer/citations fields (FR-10/FR-11) | `src/lib/rag/engine.ts`, `src/app/api/v1/ask/route.ts` | refusal accuracy **100%** + citation validity **100%** (CI eval); refusal-integration tests | F3 done |
| 4 | Human-in-the-loop (7133) | Answer sign-off `draft → approved \| rejected`, separation of duties, append-only audit, verified library (F-4, FR-14/FR-15) | `src/app/api/v1/answers/[id]/{approve,reject}`, `src/lib/audit.ts` | integration lifecycle + `SELF_APPROVAL_FORBIDDEN` + 409 tests; e2e `ask-signoff.spec.ts` | F3 done |
| 5 | Evaluation (7133/7167) | Versioned fixtures (golden-QA 52, refusal 22), CI-gated full eval, persisted run history + reviewer dashboard (F-6, FR-19…FR-21) | `scripts/eval-mro/{retrieval,full}.mjs`, `src/app/api/v1/evals`, `eval-reports/` | CI gates: recall@5 0.9231 · refusal 1.00 · citation validity 1.00 · grounded 0.8462 (final-eval-report-f5.md) | F3+F5 done |
| 6 | Predictive model in production (7167) | C-MAPSS-trained GBM RUL serving with provenance on every response, fleet dashboard, maintenance-window alert lifecycle (F-5, FR-16…FR-18, ADR-0011) | `services/mro-copilot/ai-service/mro_ai/{train,rul,cmapss}.py`, `models/`, `src/app/api/v1/engines`, `src/lib/engines/alerts.ts` | pytest reproducibility (same seed ⇒ identical sha256) + tamper + committed-RMSE gate; engines integration (RBAC, provenance, honesty `latestRul: null`); e2e `engines.spec.ts` | F4 done |
| 7 | MLOps: model versioning (7167) | Seeded training CLI → semver artifact + metrics.json + sha256 pinning, verified at load; `MODEL_NOT_LOADED` 503 (ADR-0011) | `mro_ai/train.py`, `models/metrics.json`, `mro_ai/main.py` (registry) | `tests/test_rul_train.py`, `tests/test_health.py`; provenance contract fixtures (`rul_contract.json`) | F4 done |
| 8 | AI-app reliability: observability, degradation (7133) | `/healthz` `/readyz` dependency reports on both services; degradation ladder `hybrid→lexical`; error envelopes with requestIds; idempotency keys (FR-2/FR-7) | `src/app/api/v1/{healthz,readyz}`, `src/lib/api/respond.ts`, `retrieval.py`, ADR-0013 pool | degradation-ladder integration tests; readyz readiness matrix; schema/idempotency tests | F3–F4 done |
| 9 | Drift handling / automated retraining (7167) | **Documented OUT of scope** (PRD §6): versioned artifacts + committed eval reports are the bar; revisit via ADR | PRD §6, data-model.md §9 | — (honest limitation, D-07) | documented F5 |
| 10 | Load/latency evidence (engineering-standards, milestones §F5) | k6 + independent probe harness; ask gate verified within stated host-load envelope; search 100-VU honestly unverified on shared desktop (D-07) | `scripts/loadtest/mro-*.js`, `run-mro-loadtest.mjs`, load-report-f5.md | committed run archives + host-noise snapshots; ask p95 1.7–2.0 s < 2.5 s at load ≲ 15 | F5 done (degradation documented) |

## 3. rebook-ai — disruption concierge (SITA/Amadeus event-driven rows, SIA CX, CAG Req 7133)

Requirement sources: target-roles.md §2 (Req 7133 Full Stack GenAI rows) and §3
(SITA/Amadeus SWE, SIA Service Designer CX). Feature refs are PRD F-1…F-7 / FR-n;
evidence links are the milestone reports plus load-report-f5.md under
`docs/04-projects/rebook-ai/`.

| # | JD requirement | Feature (PRD ref) | Code path | Tests | Status |
|---|---|---|---|---|---|
| 1 | Event-driven architecture at travel-tech scale (SITA/Amadeus) | PostgreSQL event log as queue of record + saga tables; TS orchestrator worker on loopback (F-0, ADR-0014) | `services/rebook-ai/orchestrator/src/{engine/tail.ts,domain/event-log.ts}`, `apps/rebook-ai/src/db/schema.ts` | orchestrator integration (claim/poison/attempts-cap); poison e2e surface; unit tests | F1–F2 done; ×10 load evidence F5 (load-report-f5.md) |
| 2 | CX engineering under failure (SIA Service Designer) | Proactive ranked offers + SNS-shaped inbox notification within seconds of IROPS (F-1/F-2) | `orchestrator/src/domain/handlers.ts`, `apps/rebook-ai/src/components/trip-{panel,timeline}.tsx` | scenario-offers integration (< 10 s single-shot + visibility poll); e2e `passenger-flow.spec.ts` | F2 done |
| 3 | Explainable ranking (7133 AI transparency) | Deterministic fast/cheap/flexible ranking with per-rank reasons + ranking hash (F-2, FR-4/FR-5) | `orchestrator/src/domain/ranking.ts`, committed inventory fixtures | ranking unit tests (determinism, policy caps, SSR/tier order); golden determinism CI assert | F2 done |
| 4 | Rule-based compensation with audit trail (7133) | Auto voucher with explainable criteria (rule + met flag + evaluated detail) (F-3, FR-6) | `orchestrator/src/domain/vouchers.ts`, wallet in `trip-panel.tsx` | vouchers unit tests (tier/kind thresholds, caps); passenger journey e2e | F2 done |
| 5 | GenAI: AI agents, tool use, guardrails (7133) | Propose-only agent loop — search_routings → price → check_policy, traced + bounded, `source`/`provider` badges, mock|real gateway (F-5, FR-8…FR-11, ADR-0003) | `orchestrator/src/domain/agent-loop.ts`, `packages/llm-gateway`, `proposal-panel.tsx` | proposals integration suite (RBAC, trace fields, budget); e2e `agent-flow.spec.ts` | F3 done |
| 6 | Human-in-the-loop (7133) | Supervisor approve/reject through the ONE saga path (no side door); append-only audit "who decided what for whom, when" (F-6/F-7, FR-12…FR-14) | `src/app/api/v1/proposals/[id]/approve`, `src/lib/audit.ts`, supervisor console | proposals lifecycle integration (gate rejections, 409s); audit integration; demo-run-f5.md beat 6 | F3–F4 done |
| 7 | Distributed-transaction / reliability instincts (SITA/Amadeus) | Compensable saga (seat → payment → ticket) with per-step idempotency, crash-safe resume, reverse compensation; exactly-one-effect under N-way confirm concurrency (F-6, api-contracts §5) | `apps/rebook-ai/src/lib/data/fulfillment.ts`, `orchestrator/src/domain/saga.ts` | saga integration (step states, compensation, injected PSP decline); **N-way same-key/distinct-key race tests**; load-verified effects in PG (results/rebook/paced/) | F3–F4 done; F5 verified under load |
| 8 | Document-based data models (7133) | PNR document, offer context, voucher criteria, saga stubs in JSONB with GIN indexes — the MongoDB-shape trade-off written down (ADR-0015) | `apps/rebook-ai/src/db/schema.ts`, migration `rebook_ai` | schema/migration integration tests (GIN exists, constraints) | F1 done |
| 9 | AuthN/AuthZ + idempotent APIs (7133) | JWT sessions + role ladder (passenger < agent < supervisor), ownership-scoped reads, REQUIRED Idempotency-Key with PG replay store (FR-2, §5) | `src/lib/auth/`, `src/lib/api/{idempotency,respond}.ts`, `packages/contracts` | rbac/jwt unit tests; RBAC matrix e2e; confirm 400/403/409/401 integration | F1–F2 done; F5 concurrency hardening |
| 10 | Realtime UI + projection discipline | SSE `chan:rb:live` bridge, priority-sorted live queue, rebuildable-from-PG projection with 250 ms coalesced refresh (F-4, ADR-0016) | `src/app/api/v1/{queue,live}/route.ts`, `orchestrator/src/domain/queue.ts` | queue live integration (< 1 s after append); coalescer unit tests; **bench:rebook-queue p95 791 ms < 1 s** | F2 done; F5 hardened |
| 11 | CI/CD, load evidence, observability (7133) | GitHub Actions `rebook.yml` (compose smoke + integration) + `ci.yml`; k6 ×10 load harness with committed evidence; /healthz /readyz /metrics both services | `.github/workflows/rebook.yml`, `scripts/loadtest/run-rebook-loadtest.mjs`, `*/healthz`+`readyz` routes | paced ×10 offer gate **PASS (p95 9.7 s)**; saturation burst honestly FAIL documented; exactly-one-effect verified in PG; readyz matrix tests | F5 done (load-report-f5.md) |
| 12 | Deployment topology (D-12 mirror) | Prod compose + Caddy auto-TLS + prod images, loopback-validated (health/ready, seeded logins, demo beat) | `infra/deploy/rebook/`, `apps/rebook-ai/Dockerfile`, `services/rebook-ai/orchestrator/Dockerfile` | runbook-validated locally (recorded); live deploy awaits DNS/secrets human steps | F5 done (structure + local validation) |

## 4. Usage Protocol

1. Before building a feature: confirm it has a row here.
2. After building: fill Code path + Tests columns; link the PR.
3. When writing a CV or interview answer: this table IS the evidence list.
4. Agents must update this file in the same milestone that adds the feature — not later.
