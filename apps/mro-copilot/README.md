# MRO Copilot

Maintenance-manual RAG copilot with page-level citations, refuse-when-ungrounded
guardrails and human-in-the-loop answer sign-off, plus an engine-health (RUL)
dashboard — for the fictional NX-320 fleet. **Simulated data for portfolio
purposes** (data-ethics.md).

- **Web** (Next.js, TS): UI, REST `/api/v1`, auth + RBAC, RAG orchestration →
  `apps/mro-copilot`, dev port **3003**
- **ai-service** (FastAPI, Python): embeddings, hybrid retrieval, RUL serving,
  Python port of the ADR-0003 gateway → `services/mro-copilot/ai-service`,
  dev port **4103** (loopback only, bearer `AI_SERVICE_TOKEN`)
- **Database**: `mro_copilot` in the shared PostgreSQL 16 cluster with
  **pgvector** (ADR-0010); no Redis for this project (architecture.md §1)

Status: **F1 — scaffold & skeleton**. Screens fill in with F2 (corpus, search),
F3 (RAG + sign-off), F4 (engine health), F5 (evidence).

## Quickstart (clean clone)

```bash
pnpm install
docker compose --profile mro up -d
```

Then open **http://localhost:3003** and sign in with a seeded demo account:

| Role | Email | Password |
|---|---|---|
| reviewer | `wei.lim@mro-sim.example` | `reviewer-nx-01` |
| engineer | `siti.rahayu@mro-sim.example` | `engineer-nx-01` |
| viewer | `tom.ng@mro-sim.example` | `viewer-nx-01` |

The first boot of the web container installs the workspace, creates the
`mro_copilot` database, applies migrations (including `CREATE EXTENSION vector`
+ HNSW/GIN indexes) and upserts the seeded users. `docker compose logs -f
mro-web` shows progress. Teardown: `docker compose --profile mro down`.

## Host-side development (without the containerized web)

```bash
cp .env.example .env                    # provides MRO_* vars + AUTH_SECRET
docker compose --profile mro up -d postgres mro-ai-service
pnpm seed:mro                           # ensure DB + migrations + seeded users
pnpm --filter mro-copilot dev           # Next dev on :3003
```

## Checks

```bash
pnpm typecheck                          # tsc strict across the workspace
pnpm lint                               # prettier + eslint (zero warnings)
pnpm --filter mro-copilot test          # vitest unit (no DB)
# Python ai-service (host has no pip — run in the pinned image):
docker run --rm -v "$PWD/services/mro-copilot/ai-service:/srv" -w /srv \
  python:3.12-slim sh -c \
  "pip install -q -r requirements-dev.txt && ruff check . && ruff format --check . && mypy mro_ai && pytest"
```

Integration tests (needs the mro compose stack):

```bash
pnpm --filter mro-copilot test:integration
```

with `MRO_DATABASE_URL`, `MRO_BASE_URL` (default `http://localhost:3003`),
`MRO_AI_SERVICE_URL` (default `http://localhost:4103`) and `AI_SERVICE_TOKEN`
from your `.env`.

## Commands

| Command | Purpose |
|---|---|
| `pnpm seed:mro` | ensure `mro_copilot` DB + migrations + seeded users |
| `pnpm db:generate:mro` | drizzle-kit migration SQL from the mro schema |
| `pnpm db:migrate:mro` | apply pending mro migrations |

## Documentation

- PRD / architecture / data model / API contracts:
  `docs/04-projects/mro-copilot/`
- ADR-0010 (pgvector), ADR-0011 (RUL model), ADR-0012 (AI topology)
- Design system: `docs/02-standards/ui-design-system.md`
