# ADR-0004: Monorepo with Shared Design System and Event-Contract Conventions

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-09-22 |
| Supersedes | — |
| Related | D-08, monorepo-architecture.md |

## Context

Three related projects will be built sequentially by coding agents. Separate repositories
would triplicate CI setup, design tokens, and conventions; agents would re-litigate the
same scaffolding decisions three times (drift risk).

## Decision

One **pnpm-workspace monorepo**:

```
apps/<project>/        # Next.js application + API routes per project
services/<project>/*   # non-frontend services (realtime, simulator, AI) per project
packages/ui            # shared design system (tokens, components) — generic only
packages/contracts     # shared event envelope + API error/pagination conventions
packages/config        # shared tsconfig, eslint, prettier, tsup config
infra/<project>/       # per-project IaC-ready deployment structure
docs/                  # this documentation tree (source of truth)
```

Cross-project imports are limited to `packages/*`. Project domain code never imports
another project's domain code.

## Alternatives considered

1. **Polyrepo** — clean boundaries; rejected: 3× CI/scaffold duplication, slower agent cycles.
2. **Nx/Turborepo** — caching benefits; rejected for now: extra tooling to lock and maintain; pnpm workspace scripts suffice at this scale (can be revisited by ADR if build times demand).

## Consequences

- (+) One CI template, one design language, agents reuse proven patterns.
- (+) Reviewer sees engineering discipline at repo level.
- (−) `packages/ui` must stay domain-neutral (a timeline component is generic; "flight" logic is not).
- (−) Requires workspace hygiene in CI (affected-only builds via path filters).
