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
| 4 | Document-based data models | Replan scenario + task config stored as JSONB documents in PostgreSQL (divergence from MongoDB: ADR-0002) | `apps/turnaround-iq/src/db` | schema integration tests | planned (F2) |
| 5 | Git workflows | Conventional commits, PR flow, branch strategy | repo-wide | CI gates | F1 done |
| 6 | REST API design/integration | Versioned REST + WS contracts | `apps/turnaround-iq/src/app/api`, api-contracts.md | contract tests | F1 auth+board routes + zod contracts done; full surface F2 |
| 7 | Docker containerisation | Compose for local; production Dockerfiles | `infra/compose` | compose smoke in CI | F1 done (profile `turnaround` + CI smoke); prod Dockerfiles F5 |
| 8 | AuthN/AuthZ, roles | Seeded users, JWT sessions, RBAC (coordinator/supervisor/viewer) | `apps/turnaround-iq/src/lib/auth` | RBAC + JWT unit tests; CI compose login smoke | F1 done (Cognito-shaped provider, D-09); server-side matrix e2e F2 |
| 9 | AWS integration | AWS service mapping + IaC-ready deploy config (CDK-compatible structure) | `infra/` | — | planned (F5) |
| 10 | CI/CD, automated testing, logging, monitoring | GitHub Actions pipeline; structured logs + metrics + dashboard | `.github/workflows/ci.yml`, `src/lib/api/respond.ts` | pipeline green | F1 pipeline + JSON logs done; metrics/Grafana F5 |
| 11 | Problem discovery → prototyping → production ownership | PRD problem statement + demo script + production-hardening milestone | docs + F5 | — | docs done |

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
