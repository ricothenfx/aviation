# Rebook.ai — Passenger Disruption Concierge

Two-sided disruption concierge (portfolio, simulated data): proactive ranked rebooking
offers for passengers within seconds of a disruption, plus an agent console whose
agentic workflow prepares rebooking decisions for human approval. Fictional carriers
only (NX NordicX, SV Sentosa Air, BH Blue Harbor Air) — `docs/04-projects/rebook-ai/PRD.md`
is the product source of truth.

## Stack slice (locked, `docs/03-platform/tech-stack.md`)

- `apps/rebook-ai` — Next.js 15 (App Router) web on :3004: passenger surface + agent
  console UI + `/api/v1` REST + auth (D-09, roles `passenger < agent < supervisor`).
- `services/rebook-ai/orchestrator` — TS worker on :4104 (`@aviation/rb-orchestrator`):
  scenario clock, offer ranking, agent loop (propose-only), fulfillment saga,
  SNS-shaped notifications (ADR-0014). F1 ships health/ready/metrics + provider wiring.
- Shared postgres (database `rebook_ai`, ADR-0015) + redis (live projections + control).
- `packages/contracts` — rebook event vocabulary (additive, `rebook-ai/api-contracts.md` §2).

## Run from a clean clone (compose profile `rebook`)

```bash
pnpm install
docker compose --profile rebook up -d      # web :3004 (self-builds, seeds, serves) + orchestrator :4104
```

Readiness: `curl localhost:3004/healthz`, `curl localhost:3004/readyz`,
`curl localhost:4104/healthz`, `curl localhost:4104/readyz` (reports postgres, redis,
provider). Seeded logins (data-ethics §5 — fake from birth):

| Role | Email | Password |
|---|---|---|
| passenger | `nadia.cho@pax-sim.example` | `passenger-nx-01` |
| agent | `amir.hassan@nx-sim.example` | `agent-nx-01` |
| supervisor | `grace.tan@nx-sim.example` | `supervisor-nx-01` |

## Host-side development

```bash
cp .env.example .env                       # AUTH_SECRET required (dev throwaway ok)
docker compose --profile infra up -d       # postgres :5433 (+ redis for the orchestrator)
pnpm seed:rebook                           # ensure rebook_ai DB + migrations + users
pnpm --filter rebook-ai dev                # web on :3004
pnpm --filter @aviation/rb-orchestrator dev # orchestrator on :4104
```

## Checks

```bash
pnpm lint            # prettier + eslint, zero warnings
pnpm typecheck       # strict tsc across the workspace
pnpm test            # unit (contracts, auth, orchestrator server)
pnpm --filter rebook-ai test:integration   # needs the rebook compose stack
```

All data is simulated and visibly labeled in the UI ("Simulated data for portfolio
purposes"). No real PNRs, carriers, or payments — see `docs/02-standards/data-ethics.md`.
