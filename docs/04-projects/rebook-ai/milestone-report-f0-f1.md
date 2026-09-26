# Rebook.ai — Milestone Report F0+F1

| Field | Value |
|---|---|
| Milestones | F0 — Documentation · F1 — Scaffold & Skeleton (combined per explicit user kickoff, D-05 exception noted in milestones.md) |
| Date | 2026-09-26 |
| Status | DONE — all DoD items evidenced below |

## What shipped

**F0 (spec, from the 2026-09-22 skeleton's "TODO at spec time"):**
- `PRD.md` v1.0 — problem, users, F-1…F-7 in-scope features, OUT OF SCOPE (binding),
  demo-verifiable success metrics, domain primer.
- `architecture.md` — two-service topology (web :3004 + orchestrator :4104), core flows
  (disruption→offers, confirm→saga, propose-only agent loop), realtime/consistency,
  auth (D-09), failure handling, observability, deployment shape.
- `data-model.md` — ERD, table notes, Redis key design, synthetic seed plan (fictional
  NX/SV/BH per data-ethics.md §2), volumes, migration discipline.
- `api-contracts.md` — REST surface, rebook event vocabulary (13 types, additive),
  Redis frames, orchestrator internal surface, behavioral contracts (CI-asserted).
- `milestones.md` — F0–F5 with binding DoD + handoff protocol.
- `demo-script.md` — 90 s beat sheet (cancellation → new boarding pass), fictional cast.
- **ADR-0014** (orchestrator topology: Postgres queue-of-record, propose-only agent,
  compensable saga, SNS-shaped notifications) and **ADR-0015** (PostgreSQL JSONB
  document store — the honest MongoDB-shape evaluation the skeleton mandated);
  decision-log **D-20 / D-21** appended.

**F1 (scaffold, per the F1 section of the new milestones.md):**
- `apps/rebook-ai` — Next.js 15 on :3004: login (seeded accounts), passenger trip shell +
  agent console shell, both rendering real fetches with loading/empty/error/live states
  (ui-design-system §7) and the simulated-data footer; `/api/v1/auth/{login,logout}`,
  `/api/v1/pax/summary`, `/api/v1/queue` (F1 contract slices, honest `null`/empty values);
  `/healthz`, `/readyz`; auth module per D-09 (argon2id + JWT, roles
  `passenger < agent < supervisor`); drizzle migration 0000 (`users`); `seed:rebook`.
- `services/rebook-ai/orchestrator` (`@aviation/rb-orchestrator`) — TS worker on :4104:
  `/healthz` `/readyz` `/metrics` (Prometheus text), dependency checks (postgres, redis,
  provider incl. the deterministic mock-provider ping and the honest `off (degrade)`
  label), graceful shutdown, structured pino logs.
- `packages/contracts` — rebook event vocabulary + payload schemas + typed-event
  registry + error codes, all additive; `Turnaround*`/`Rebook*` type helpers so the
  turnaround exhaustiveness guards stay strict (D-11/D-14 consumer-update precedent).
- Compose profile `rebook` (postgres `rebook_ai` + redis + web :3004 + orchestrator
  :4104, loopback-only), `.env.example` section, path-filtered `.github/workflows/rebook.yml`,
  root scripts (`seed:rebook`, `db:generate:rebook`, `db:migrate:rebook`), AGENTS.md §5 updated.

## DoD evidence (milestones.md F1)

| DoD item | Evidence |
|---|---|
| Clean clone: `pnpm install && docker compose --profile rebook up -d` serves both services healthy | Ran twice from wiped volumes (`down -v` → `up -d --wait`): web + orchestrator `Healthy`; web readyz `{postgres: up, provider: up (mock)}`; orchestrator readyz `{postgres: up, redis: up, provider: up (mock)}`; README documents the run |
| CI green: lint + typecheck + unit + build, zero warnings, strict TS | Local full gates green (same lane as `rebook.yml`'s parent CI): `pnpm lint` clean · `pnpm typecheck` 13/13 packages · `pnpm test` 138 unit tests passing · `pnpm build` all apps compiled; workflow committed as `rebook.yml` |
| Seeded logins per role; RBAC ladder server-side | Compose smoke: all three logins return their role; `GET /api/v1/queue` = 401 anon / 403 passenger / 200 agent+supervisor (unit: `rbac.test.ts`, `jwt.test.ts`; integration: `auth-rbac.test.ts` 5/5) |
| `rebook_ai` created idempotently; users + argon2 after seed | `tests-integration/migrate.test.ts` 3/3 (role enum order, argon2id hash format, re-seed upsert does not duplicate) |
| Contract test: every rebook event validates; envelope invariants | `packages/contracts/test/contracts.test.ts` rebook block (8 tests): all 13 types parse via `parseTypedEvent`, undocumented role/missing reject-note rejected, uuid/sequence invariants hold |
| `/healthz` + `/readyz` both services; orchestrator reports db, redis, provider | Verified over HTTP in compose smoke; unit `server.test.ts` covers 200/503/degrade-label/metrics; integration `readyz.test.ts` 3/3 |
| Shell states from real fetches + simulated-data footer | `trip-panel.tsx` / `queue-panel.tsx` fetch the real endpoints (loading skeletons, EmptyState, ErrorState+retry, live freshness cue); footer in root layout |
| ADR compliance: no library outside tech-stack.md | Only workspace packages + already-locked deps (next, pg, drizzle, jose, argon2, pino, zod); no new runtime dependency introduced |

## Deviations / notes

- The additive event vocabulary widened the shared unions, so turnaround-iq consumers
  needed type-level updates (`projections.ts` narrowed to `TurnaroundEventType`;
  three insert sites cast `aggregateType` to the turnaround enum). This is the
  D-11-sanctioned additive consumer update; behavior unchanged, all 107 pre-existing
  turnaround/mro unit tests still pass.
- One real defect was found and fixed during the from-scratch run: the orchestrator
  originally built its DB client from `@aviation/db`'s `DATABASE_URL` default and
  honestly reported `postgres: down` in `readyz` inside compose. Fixed by resolving
  `REBOOK_DATABASE_URL` explicitly (the readiness gate did its job).
- Environmental note: root-owned `.next` artifacts from earlier containerized builds
  blocked `pnpm build` on the host; removed via a throwaway node container (gitignored
  artifacts only).

## Document sections relied upon (AGENTS.md §3)

- Kickoff skeleton: `docs/04-projects/rebook-ai/PRD.md` (2026-09-22) — scope, stack
  deltas, "TODO at spec time" list.
- Governance: `AGENTS.md` §2 truth hierarchy, §3 rules (ADR-before-code, DoD, data
  ethics), §5 commands; `docs/01-decisions/decision-log.md` D-02/D-03/D-05/D-08/D-09/D-10.
- Platform: `docs/03-platform/tech-stack.md` (locked stack; §2 SNS/notification mapping),
  `docs/03-platform/monorepo-architecture.md` §1–4 (layout, boundaries, compose, CI).
- Standards: `docs/02-standards/engineering-standards.md` §1–§8 (DoD, testing, API/event
  conventions, observability, DB discipline), `docs/02-standards/ui-design-system.md`
  §1–§9, `docs/02-standards/data-ethics.md` §1–§5.
- Precedent ADRs: ADR-0002 (JSONB evaluation baseline), ADR-0003 (gateway),
  ADR-0004/D-08 (monorepo); precedent decisions D-11 (worker topology), D-14/D-15
  (additive contracts, honest nulls).
