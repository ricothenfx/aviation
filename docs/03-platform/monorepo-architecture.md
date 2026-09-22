# Monorepo Architecture

| Field | Value |
|---|---|
| Status | Binding layout (ADR-0004, D-08) |
| Package manager | pnpm workspaces |

## 1. Repository Layout

```
aviation/
├── AGENTS.md
├── README.md                    # index + landing content (filled at F1)
├── docs/                        # source of truth (this tree)
├── apps/
│   ├── turnaround-iq/           # Next.js app (UI + REST API routes) + seed/
│   ├── mro-copilot/             # built in phase 2
│   └── rebook-ai/               # built in phase 3
├── services/
│   └── turnaround-iq/
│       ├── realtime-gateway/    # Node ws server: broadcasts projection deltas
│       ├── simulator/           # scenario engine producing ground-task events
│       └── replan-engine/       # constraint scheduler + LLM copilot client
├── packages/
│   ├── ui/                      # design system: tokens + generic components
│   ├── contracts/               # event envelope, API error/pagination schemas (zod)
│   ├── db/                      # shared migration runner + pg/redis client factories
│   ├── llm-gateway/             # ADR-0003 provider abstraction (+ mock provider)
│   └── config/                  # tsconfig, eslint, prettier, tsup presets
├── infra/
│   ├── compose/                 # docker-compose base + per-project overrides
│   ├── turnaround-iq/           # IaC-ready deploy structure (F5)
│   └── observability/           # prometheus + grafana configs (F5)
└── .github/workflows/           # ci.yml, e2e.yml
```

## 2. Dependency Rules (enforced by eslint boundaries)

- `apps/*` and `services/*` may import `packages/*` only.
- `packages/*` must never import from `apps/*` or `services/*`.
- No cross-project imports (`apps/turnaround-iq` ↮ `apps/mro-copilot`).
- Domain logic (schedulers, risk rules, projections) lives in `services/<project>/domain` or app-local `src/domain` — never in `packages/ui`.

## 3. Local Development Topology (docker compose)

| Container | Image/port | Notes |
|---|---|---|
| postgres | postgres:16 + timescaledb-HA | one cluster, per-project databases |
| redis | redis:7 | live state + pub/sub |
| web (per active project) | node:22, Next dev server | `apps/<project>` |
| realtime / simulator / replan | node:22 | started per project via compose profile |
| prometheus + grafana | F5 | observability stack |

Compose **profiles** keep resource use sane: only the active project's services start (`docker compose --profile turnaround up`).

## 4. CI (GitHub Actions)

- `ci.yml`: path-filtered — a PR touching `apps/turnaround-iq/**` runs that app's checks plus `packages/*` affected by boundary graph; docs-only PRs skip heavy jobs.
- `e2e.yml`: nightly + on milestone-label PRs — full Compose stack, Playwright suite.
- Pipeline definition owned by `packages/config` docs; workflows stay thin.

## 5. Environments

| Env | Target | Purpose |
|---|---|---|
| local | Docker Compose | daily dev + demos |
| live demo | Vercel (web) + single VM/Fly.io (services) | public link for CV/README (F5) |
| aws-shape | not deployed — IaC-ready structure + mapping table in tech-stack.md | interview narrative |

## 6. Build Order per Project

F1 scaffold → F2 core domain → F3 intelligence → F4 polish → F5 evidence.
Detailed per-project definitions live in `docs/04-projects/<project>/milestones.md`.
