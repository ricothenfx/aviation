# Decision Log

| Field | Value |
|---|---|
| Status | Binding, append-only |
| Created | 2026-09-22 |
| Governance | New decisions get a new ID here + (if architectural) an ADR in `adr/`. Superseding requires a new entry pointing at the old one. Never edit a decided entry. |

## Decisions

| ID | Date | Decision | Alternatives rejected | Consequence |
|---|---|---|---|---|
| D-01 | 2026-09-22 | Portfolio track = **senior Full-Stack TypeScript/Next.js**. Seniority must show through architecture depth: ADRs, trade-off narratives, production-hardening (observability, failure handling), not through feature count. | AI/ML-first track; pure frontend track | 1 deep primary JD target (CAG Req 7075). AI appears as a layer inside full-stack systems, never as a standalone notebook. |
| D-02 | 2026-09-22 | Build order locked: **turnaround-iq → mro-copilot → rebook-ai**. turnaround-iq has the widest employer coverage and maps 1:1 to CAG Req 7075. | mro-copilot first (AI depth) | No project starts before its predecessor reaches F5 (unless user says so). |
| D-03 | 2026-09-22 | Stack locked: TypeScript + Next.js + Tailwind (UI), PostgreSQL + TimescaleDB (relational + time-series), Redis (live state/pub-sub), Python FastAPI only for AI-serving services, Docker Compose (local), AWS-native service mapping + IaC-ready config, GitHub Actions CI, Playwright e2e. Versions locked in tech-stack.md. | MongoDB (CAG stack — see ADR-0002); Node-only AI (ecosystem too weak for eval/ML); Kubernetes (ops overhead unjustified for portfolio) | Agent may not introduce any library/category outside tech-stack.md without an approved ADR. |
| D-04 | 2026-09-22 | turnaround-iq core = **event-driven with event sourcing** for the ground-task log (see ADR-0001). All state changes arrive as immutable events from the simulator; read models are projections. | CRUD + polling | Enables replayable disruption scenarios, audit trail, honest real-time claims. Read-model complexity must be handled, documented in code. |
| D-05 | 2026-09-22 | Build executed **by coding agents in milestone increments** with hard quality gates (DoD per milestone in milestones.md; CI non-negotiable; tests cannot be skipped/vacuous). | Continuous unstructured agent sessions | User reviews each milestone; agents must not jump ahead of the assigned milestone. |
| D-06 | 2026-09-22 | **Public repository documents in English** (README, PRD, ADR, code, commit messages) because Singapore reviewers may read them. Live conversation with the user may be Indonesian. | Indonesian docs | All docs in this repo are written in English. |
| D-07 | 2026-09-22 | **All data synthetic/simulated, visibly labeled in the UI.** Allowed datasets only: NASA C-MAPSS, OpenSky Network (research terms), OurAirports, hand-written scenarios. No real-company affiliation claims, logos, PNRs. | Scraping real ops data; unbranded realism | Every screen carries a "Simulated data" disclaimer. data-ethics.md is binding. |
| D-08 | 2026-09-22 | The 3 projects live in **one monorepo sharing a design system, event-contract conventions, CI, and infra patterns** to cut total build time (see ADR-0004). | 3 separate repos | packages/ shared code must stay generic; no cross-import of project-specific domain logic. |
| D-09 | 2026-09-22 | AuthN in local dev = seeded users + JWT sessions through a provider abstraction whose AWS target is **Cognito**; RBAC roles per project (turnaround-iq: coordinator / supervisor / viewer). | Full Cognito from day one (blocks local dev); no auth (fails JD requirement 8) | Auth module must keep the Cognito swap behind one interface; traceability-matrix row 8 depends on it. |
| D-10 | 2026-09-22 | LLM integration must go through a **provider-agnostic gateway abstraction** with local mock mode (see ADR-0003), so demos work offline and cost-zero while remaining Bedrock-compatible in shape. | Direct SDK calls to a single vendor | Copilot features degrade gracefully to rule-based engines when the LLM layer is off. |
| D-11 | 2026-09-23 | turnaround-iq F3: replan-engine deploys as a **sixth compose worker service** (risk daemon tails PG event_log; replan RPC via `chan:replan:control` + result keys; approved plans applied as `task.rescheduled` events). Replan lifecycle events `replan.approved`/`replan.rejected` join the contracts **additively** (ws frames included). Confirmed with the user in-session; details in ADR-0005. | Rule engine inside the web container (blurs architecture.md §2 boundaries); HTTP RPC service (extra plumbing for one command) | Decisions read PostgreSQL only; same seed + log ⇒ identical plan hash is CI-tested; one more container in CI. |

## Supersession History

- (empty — no decision has been superseded yet)
