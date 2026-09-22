# Aviation Portfolio — Singapore

A portfolio of 3 aviation-domain software projects built to demonstrate senior full-stack
engineering (TypeScript / Next.js) with applied AI, targeting software engineering roles at
Singapore aviation companies.

> **All data in every project is simulated for portfolio purposes.** No affiliation with any
> real company is claimed or implied. See `docs/02-standards/data-ethics.md`.

## Projects (build order locked — D-02)

| # | Project | Status | Spec |
|---|---|---|---|
| 1 | **turnaround-iq** — AI-assisted aircraft turnaround command center | F2 core domain (events · projections · live board) | `docs/04-projects/turnaround-iq/` |
| 2 | **mro-copilot** — maintenance-manual RAG copilot + engine health | spec pending | `docs/04-projects/mro-copilot/PRD.md` |
| 3 | **rebook-ai** — passenger disruption concierge | spec pending | `docs/04-projects/rebook-ai/PRD.md` |

## Quickstart (turnaround-iq)

Prerequisites: Node 22 (`.nvmrc`), corepack pnpm 9, Docker with Compose v2.

```bash
pnpm install                                   # install workspace dependencies
pnpm dev                                       # postgres+redis (compose) + Next dev on :3000
```

The first run needs the schema and demo users:

```bash
pnpm seed                                      # migrations + seeded users (viewer/coordinator/supervisor)
```

Sign in on http://localhost:3000 with a seeded account, e.g. coordinator
`maya.tan@nx-sim.example` / `coordinator-nx-01` (all accounts are fictional demo data).
Supervisor (scenario start/reset + speed control): `priya.nair@nx-sim.example` / `supervisor-nx-01`.

Full containerized mode (no host Node needed at runtime) — postgres + redis + web on
**http://localhost:3001**, plus the simulator (scenario clock → event log) and the
realtime gateway (projection worker + ws on **ws://localhost:4001/api/ws**); containers
install, seed and serve by themselves:

```bash
docker compose --profile turnaround up -d
docker compose --profile turnaround down -v
```

Start the reference scenario (supervisor) from the board's scenario console, or via REST:
`POST /api/v1/scenarios/reference-day/start {"speed": 20}` — the board then updates live
over WebSocket from the event-sourced ground-task log.

All operational data is simulated (see `docs/02-standards/data-ethics.md`); every screen
carries the disclaimer. For host-side runs, copy `.env.example` to `.env` and set a real
`AUTH_SECRET` (`openssl rand -base64 32`).

## Documentation Map

| Path | Contains |
|---|---|
| `AGENTS.md` | Working rules for coding agents (read this first) |
| `docs/00-context/` | Market research, target JDs, requirement traceability |
| `docs/01-decisions/` | Decision log (binding) + ADRs |
| `docs/02-standards/` | Engineering, UI design system, data ethics |
| `docs/03-platform/` | Monorepo layout, locked tech stack |

## Commands

```bash
pnpm dev                 # infra (compose profile "infra") + Next dev server on :3000
pnpm build               # build packages (tsup) + apps (next build)
pnpm lint                # prettier --check + eslint (zero warnings)
pnpm typecheck           # tsc --noEmit strict across the workspace
pnpm test                # vitest unit tests across the workspace (no DB)
pnpm test:integration    # vitest integration tests against the compose stack
pnpm seed                # apply migrations + reference day + seeded demo users
pnpm db:generate         # drizzle-kit generate migration SQL
pnpm db:migrate          # apply pending migrations
```

CI (`.github/workflows/ci.yml`) runs lint → typecheck → unit → build, plus a
compose-stack job that boots the full `turnaround` profile (postgres · redis · web ·
simulator · realtime-gateway), logs in as a seeded coordinator, runs the integration
suite (ADR-0001 golden replay, idempotency, worker latency, RBAC matrix) and the
board-latency benchmark (p95 < 1 s target) on every push/PR.

## Evidence & Traceability

Every feature traces to a real Singapore job requirement:
`docs/00-context/traceability-matrix.md` (JD requirement → feature → code → test).
