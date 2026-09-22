# Aviation Portfolio — Singapore

A portfolio of 3 aviation-domain software projects built to demonstrate senior full-stack
engineering (TypeScript / Next.js) with applied AI, targeting software engineering roles at
Singapore aviation companies.

> **All data in every project is simulated for portfolio purposes.** No affiliation with any
> real company is claimed or implied. See `docs/02-standards/data-ethics.md`.

## Projects (build order locked — D-02)

| # | Project | Status | Spec |
|---|---|---|---|
| 1 | **turnaround-iq** — AI-assisted aircraft turnaround command center | spec complete, build next | `docs/04-projects/turnaround-iq/` |
| 2 | **mro-copilot** — maintenance-manual RAG copilot + engine health | spec pending | `docs/04-projects/mro-copilot/PRD.md` |
| 3 | **rebook-ai** — passenger disruption concierge | spec pending | `docs/04-projects/rebook-ai/PRD.md` |

## Documentation Map

| Path | Contains |
|---|---|
| `AGENTS.md` | Working rules for coding agents (read this first) |
| `docs/00-context/` | Market research, target JDs, requirement traceability |
| `docs/01-decisions/` | Decision log (binding) + ADRs |
| `docs/02-standards/` | Engineering, UI design system, data ethics |
| `docs/03-platform/` | Monorepo layout, locked tech stack |

## Commands

> Populated at F1 scaffold. See `AGENTS.md` §5 for the planned set.

## Evidence & Traceability

Every feature traces to a real Singapore job requirement:
`docs/00-context/traceability-matrix.md` (JD requirement → feature → code → test).
