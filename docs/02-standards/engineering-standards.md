# Engineering Standards

| Field | Value |
|---|---|
| Status | Binding |
| Scope | All apps and services in this monorepo |

## 1. Definition of Done (per PR type)

| PR type | DoD |
|---|---|
| Feature | Lint + typecheck clean · unit tests for new logic · integration test if it touches DB/events · e2e if user-facing flow · traceability-matrix.md updated · docs updated if contracts changed |
| Bugfix | Regression test reproducing the bug · root cause stated in PR body |
| Milestone | All milestone DoD items in the project's `milestones.md` checked with evidence links |

## 2. Code Quality

- TypeScript `strict: true` everywhere. No `any` without a suppression comment stating why; `unknown` + narrowing preferred.
- ESLint + Prettier from `packages/config`. Zero warnings tolerated in CI.
- Functions: pure logic separated from I/O (testability). No business logic in React components.
- Naming: domain vocabulary from the PRD (turnaround, stand, pushback) — code should read like the domain talks.

## 3. Testing Strategy

| Layer | Tool | Rule |
|---|---|---|
| Unit | Vitest | All pure domain logic (schedulers, risk rules, projections). No DB, no mocks of the thing under test. |
| Integration | Vitest + Testcontainers-style throwaway Postgres/Redis | Event handlers, projections, repositories, API routes. |
| Contract | Vitest against `packages/contracts` schemas | WS/REST payloads validated against examples in api-contracts.md. |
| E2E | Playwright | Critical user flows only (seed → disruption → alert → replan). Runs in CI against Compose stack. |
| Load | k6 script (F5) | Sustained 200 concurrent event-consumers; p95 latency reported honestly. |

- Tests are deterministic. No `sleep`-based waits; poll or use fake timers.
- CI must run all tests on every PR. Skipped tests (`test.skip`) require a linked issue and expiry note.

## 4. API & Events

- REST: versioned prefix `/api/v1`, standard error envelope from `packages/contracts`.
- Events: envelope `{ id, type, occurredAt, aggregateId, sequence, payload }` — schema in `packages/contracts`; breaking changes = new event type version, never mutation.
- Every mutating endpoint accepts `Idempotency-Key`; handlers are idempotent.
- Pagination: cursor-based for logs; offset allowed for small reference lists.

## 5. Observability (production-readiness signal)

- Structured JSON logs (pino): `ts, level, requestId, module, msg`. One request ID per inbound request/event, propagated.
- Metrics (Prometheus format): request latency/count, event-lag, projection lag, LLM token usage. Grafana dashboard JSON committed under `infra/observability/`.
- Health endpoints `/healthz` (liveness) and `/readyz` (dependencies) on every service.

## 6. Failure Handling

- Retries with exponential backoff + jitter on outbound calls; circuit breaker on cross-service calls.
- Dead-letter handling for poison events (logged, surfaced in an admin view, never silently dropped).
- Graceful shutdown: drain WS connections, flush outbox on SIGTERM.

## 7. Git & CI

- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- Trunk-based: short-lived feature branches, PR into `main`, squash-merge.
- CI pipeline: install → lint → typecheck → unit+integration → build → e2e (Compose) → upload artifacts. Pipeline green is a merge precondition; no force-push to `main`.
- No secrets in repo: `.env.example` committed, real `.env` gitignored. CI uses dummy values.

## 8. Database Discipline

- Schema changes only via migration files (drizzle-kit or node-pg-migrate — one tool per project, locked at F1). No manual DDL.
- Migrations are forward-only; destructive changes require a deprecation note in the PR.
- Seed data lives in `apps/<project>/seed/` and is the single source for demos and tests.
