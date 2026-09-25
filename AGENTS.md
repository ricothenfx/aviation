# AGENTS.md — Aviation Portfolio Build

> This file is the **entry point for every coding agent** (human or AI) working in this repository.
> It defines how to work here. It does NOT contain specifications — those live in `docs/`.

## 1. Project Context

This repository contains a **portfolio of 3 aviation-domain software projects** built to support
job applications for software engineering roles at Singapore aviation companies
(Changi Airport Group, Singapore Airlines, ST Engineering, SATS, SITA, Amadeus, SIAEC, Rolls-Royce, etc.).

- **Portfolio positioning:** senior full-stack engineer (TypeScript / Next.js), AI-aware, aviation domain literate.
- **Build strategy:** executed by coding agents in milestone increments, under strict quality gates.
- **Market research snapshot:** 2026-09-22 (see `docs/00-context/market-research.md`).

## 2. Truth Hierarchy (when sources conflict, the higher one wins)

1. **User instructions in the live session**
2. **`docs/01-decisions/`** — decision log + ADRs (binding, append-only)
3. **`docs/04-projects/<project>/`** — PRD, architecture, data-model, api-contracts, milestones
4. **`docs/02-standards/` and `docs/03-platform/`** — how we build
5. **Existing code + its comments**

If you discover a conflict between documents, STOP and report it. Do not silently resolve it.

## 3. Mandatory Rules

### Reading before writing
- BEFORE writing any code, read: this file, `docs/01-decisions/decision-log.md`,
  and the active project's `PRD.md` + `milestones.md`.
- Reference the document sections you relied on in PR descriptions and milestone reports.

### Scope discipline
- The stack is **LOCKED** (see `docs/03-platform/tech-stack.md`). No new frameworks, databases, or infrastructure without a new ADR approved by the user.
- Features listed under **OUT OF SCOPE** in a PRD must not be built. No "while I was there" additions.
- Work only on the milestone assigned. Do not jump ahead.

### Quality gates (non-negotiable)
- A milestone is DONE only when its **Definition of Done** in `docs/04-projects/<project>/milestones.md` is fully met.
- Tests must actually run in CI. Skipping, disabling, or writing vacuous tests to pass gates is a violation.
- Lint and typecheck must pass with zero errors (TypeScript strict mode).

### Decisions & drift control
- Any technical decision not already recorded in `docs/` requires a **new ADR** first (`docs/01-decisions/adr/`), then code.
- ADRs are append-only. To change a decision, write a new ADR that supersedes the old one and update `decision-log.md`.
- If the user's live instruction conflicts with `docs/`, follow the user, then update the docs to match.

### Data & honesty
- **All data must be synthetic/simulated** and visibly labeled in the UI ("Simulated data for portfolio purposes").
- Allowed datasets only (see `docs/02-standards/data-ethics.md`): NASA C-MAPSS, OpenSky Network, OurAirports, hand-written scenarios.
- Never claim affiliation with, or endorsement from, any real company. Never use real company logos or real PNR/passenger data.
- Report metrics honestly. Never fabricate benchmark numbers.

### Security
- No secrets in the repository. Use `.env.example` + local `.env` (gitignored).
- Every externally callable endpoint implements AuthN/AuthZ as specified in the project's `architecture.md`.

### UI
- Follow `docs/02-standards/ui-design-system.md`. Generic, template-looking UI is a defect, not a style choice.
- Every screen must implement empty, loading, and error states.

## 4. Build Order (locked, see decision D-02)

1. **turnaround-iq** — AI-assisted aircraft turnaround command center (`docs/04-projects/turnaround-iq/`)
2. **mro-copilot** — maintenance-manual RAG copilot + engine health (`docs/04-projects/mro-copilot/`)
3. **rebook-ai** — passenger disruption concierge (`docs/04-projects/rebook-ai/`)

Do not start a project before the previous one reaches milestone F5 unless the user says so.

## 5. Commands

> Filled during the F1 scaffold. Keep this section current.

```bash
pnpm install            # install dependencies (Node 22 via .nvmrc, corepack pnpm 9)
pnpm dev                # infra via compose profile "infra" (postgres:5433 + redis) + Next dev on :3000
pnpm build              # build packages (tsup) + apps (next build)
pnpm lint               # prettier --check + eslint --max-warnings 0
pnpm typecheck          # tsc --noEmit strict across the workspace
pnpm test               # vitest unit tests across the workspace (no DB)
pnpm test:integration   # vitest integration tests (needs compose stack: DATABASE_URL, REDIS_URL, TIQ_BASE_URL)
pnpm test:e2e           # Playwright end-to-end tests (needs compose stack; added in F3)
pnpm bench:replan       # loader-breakdown replan benchmark: 47 → ≤ 9 min in < 2 s (pure, no stack)
pnpm eval:mro           # mro-copilot retrieval eval over golden-QA (gates recall@5 ≥ 0.85; needs mro stack)
pnpm bench:mro-search   # mro-copilot search latency benchmark (gates p95 < 300 ms; needs mro stack)
pnpm loadtest           # ×10 load gate: k6 (200 ws consumers) + independent latency probe (F5; needs compose stack; --prom feeds Grafana evidence profile)
pnpm seed               # apply migrations + reference day + upsert seeded demo users (turnaround-iq)
pnpm seed:mro           # mro-copilot: ensure mro_copilot DB + migrations + seeded users (viewer/engineer/reviewer)
pnpm --filter mro-copilot corpus:generate  # regenerate the committed NX-320 synthetic corpus (deterministic, seed/manuals)
pnpm db:generate        # drizzle-kit generate migration SQL from packages/db schema
pnpm db:generate:mro    # drizzle-kit generate from apps/mro-copilot schema (mro_copilot DB)
pnpm db:migrate         # apply pending migrations (turnaround-iq)
pnpm db:migrate:mro     # apply pending mro-copilot migrations (pgvector + chunks)

# mro-copilot stack (web :3003, ai-service :4103 loopback, shared postgres, DB mro_copilot — ADR-0012):
docker compose --profile mro up -d

# mro-copilot Python ai-service checks (host has no pip; run in the pinned image):
docker run --rm -v "$PWD/services/mro-copilot/ai-service:/srv" -w /srv python:3.12-slim sh -c \
  "pip install -q -r requirements-dev.txt && ruff check . && ruff format --check . && mypy mro_ai && pytest"

# Full containerized stack (postgres + redis + web on :3001, simulator :4101, realtime-gateway ws :4001, replan-engine :4102):
docker compose --profile turnaround up -d      # boot; web self-installs, seeds, serves
docker compose --profile turnaround down -v    # teardown

# Ephemeral evidence stack for load runs only (Prometheus :9090, Grafana :3002 — ADR-0007, never part of the demo stack):
docker compose --profile evidence up -d

# Host-side environment: cp .env.example .env (AUTH_SECRET required for host runs)
```

## 6. Language Policy (decision D-06)

- Code, code comments, README, PRD, ADR, commit messages: **English** (reviewers in Singapore may read them).
- Live-session conversation with the user: Indonesian is fine.
- All public-facing text in the apps: English.

## 7. Kickoff Prompt Template (for starting a fresh session)

> Read AGENTS.md, docs/01-decisions/decision-log.md, and
> docs/04-projects/<project>/milestones.md. Execute milestone <F#> exactly as
> specified, honoring its Definition of Done. Do not change stack or scope.
> Report which document sections guided each major choice.
