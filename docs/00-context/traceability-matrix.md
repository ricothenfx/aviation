# Traceability Matrix — JD Requirement → Feature → Code → Test

| Field | Value |
|---|---|
| Status | Living document — update at every milestone |
| Rule | No feature without a JD row. No row without evidence once built. |
| Primary JD | CAG Senior Software Engineer (Req 7075) — see target-roles.md §1 |

## 1. CAG Senior Software Engineer Requirements → turnaround-iq

| # | JD requirement | Feature (PRD ref) | Code path | Tests | Status |
|---|---|---|---|---|---|
| 1 | TypeScript production quality | All app code, strict mode | `apps/turnaround-iq`, `packages/*` | typecheck gate | planned (F1) |
| 2 | Next.js full-stack apps | Frontend + REST API routes | `apps/turnaround-iq/src/app` | e2e happy path | planned (F1–F2) |
| 3 | Tailwind CSS responsive UI | Design system tokens + components | `packages/ui` | visual smoke | planned (F1) |
| 4 | Document-based data models | Replan scenario + task config stored as JSONB documents in PostgreSQL (divergence from MongoDB: ADR-0002) | `apps/turnaround-iq/src/db` | schema integration tests | planned (F2) |
| 5 | Git workflows | Conventional commits, PR flow, branch strategy | repo-wide | CI gates | planned (F1) |
| 6 | REST API design/integration | Versioned REST + WS contracts | `apps/turnaround-iq/src/app/api`, api-contracts.md | contract tests | planned (F2) |
| 7 | Docker containerisation | Compose for local; production Dockerfiles | `infra/` | compose smoke in CI | planned (F1) |
| 8 | AuthN/AuthZ, roles | Seeded users, JWT sessions, RBAC (coordinator/supervisor/viewer) | auth module | RBAC unit + e2e | planned (F2) |
| 9 | AWS integration | AWS service mapping + IaC-ready deploy config (CDK-compatible structure) | `infra/` | — | planned (F5) |
| 10 | CI/CD, automated testing, logging, monitoring | GitHub Actions pipeline; structured logs + metrics + dashboard | `.github/workflows`, observability module | pipeline green | planned (F1, F5) |
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
