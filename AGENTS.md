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

> Fill in during milestone F1 scaffold. Agents must keep this section current.

```bash
pnpm install            # install dependencies
pnpm dev                # run all services locally (Docker Compose + dev servers)
pnpm build              # build all apps/packages
pnpm lint               # eslint + prettier check
pnpm typecheck          # tsc --noEmit across workspace
pnpm test               # unit + integration tests
pnpm test:e2e           # Playwright end-to-end tests
pnpm seed               # load synthetic seed data
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
