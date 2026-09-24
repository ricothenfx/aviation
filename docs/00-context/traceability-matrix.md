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

## 2. CAG ML Engineer (Req 7167) → mro-copilot (spec pending, D-02)

| # | JD requirement | Feature | Code path | Tests | Status |
|---|---|---|---|---|---|
| 1 | RAG with grounding/citations | Manual Q&A copilot with page-level citations | — | golden Q&A eval set | spec pending |
| 2 | Guardrails + human-in-the-loop | Answer sign-off workflow, refuse-when-ungrounded | — | guardrail tests | spec pending |
| 3 | MLOps: versioning, eval, drift | Model/eval harness (RAGAS-style), experiment tracking | — | eval report | spec pending |
| 4 | Predictive model in production | NASA C-MAPSS RUL model served via API | — | model API tests | spec pending |

## 3. Usage Protocol

1. Before building a feature: confirm it has a row here.
2. After building: fill Code path + Tests columns; link the PR.
3. When writing a CV or interview answer: this table IS the evidence list.
4. Agents must update this file in the same milestone that adds the feature — not later.
