# ADR-0019: Portfolio Landing Page — Static-Export Next.js App at `aviation.ricothen.com`, Served by the Existing Caddy Front

| Field | Value |
|---|---|
| Status | **Accepted** (user approved in-session 2026-09-27: "ok eksekusi") |
| Date | 2026-09-27 |
| Supersedes | — |
| Related | ADR-0006 (§Execution record reserves `aviation.ricothen.com` for exactly this), D-03 (locked stack), D-06 (public text in English), D-07 (honesty), D-08 (one monorepo), ui-design-system.md (binding), data-ethics.md (binding) |

## Context

All three projects are F5-complete. `turnaround-iq` is live (`turnaround-iq.aviation.ricothen.com`,
ADR-0006); `mro-copilot` and `rebook-ai` have committed prod runbooks whose live deploy awaits the
flagged human steps. A reviewer who opens a CV link has no single entry point: each project URL
stands alone, with no context about the portfolio's positioning (senior full-stack TypeScript/Next.js,
aviation domain, applied AI) or the cross-project evidence (shared design system, CI lanes, ×10 load
gates, ADR trail).

ADR-0006 §Execution record already fixed the scheme: one hostname per project, and the portfolio
landing page "later at `aviation.ricothen.com`". The `aviation` A record exists (dormant, infra/deploy/README.md);
the user confirmed 2026-09-27 that DNS for `aviation.ricothen.com` is ready. The remaining decision is
how the landing page is built and served.

## Decision

1. **New app `apps/portfolio-landing`** in this monorepo — Next.js + Tailwind + `@aviation/ui` tokens,
   identical toolchain to the other apps (D-03/D-08). Dev port 3005. No database, no auth, no API routes.
2. **Static export** (`output: "export"`): `next build` emits `out/`; the page is pre-rendered HTML +
   self-hosted fonts + static assets. The only client component is the live UTC/Singapore clock.
3. **Served by the existing `turnaround-prod` Caddy** as an additional `file_server` site block
   (`{$LANDING_DOMAIN:aviation.ricothen.com}` → root `{$LANDING_ROOT:/srv/landing}`): no new runtime
   container, no new port, no second TLS front. Deploy = copy `out/*` to `infra/deploy/landing/` on the
   host, reload Caddy.
4. **Honest, single-source project statuses** (D-07): one config module (`src/lib/projects.ts`) drives
   every status badge, demo URL, and metric on the page. Only `turnaround-iq` ships with `live`;
   `mro-copilot` / `rebook-ai` ship as `prepared` until their runbooks' live-deploy steps are executed,
   and flip in this one file. A unit test pins the honesty invariants (every `live` project must carry an
   `https://` demo URL; every metric must cite its committed report).
5. **Content is dual-audience and measured, not claimed**: aviation-language problem framing +
   engineering-reviewer architecture framing per project (the proven README pattern), with metrics
   quoted verbatim from committed reports (`load-report-f5.md`, `final-eval-report-f5.md`,
   milestone reports) and linked as evidence. Public-facing text in English (D-06).
6. **Design language compliance**: "mission control, not admin panel" — the page reuses the dark token
   set, tabular numerals, `StatusBadge`/`StatTile`/`LiveDot`/`Disclaimer` from `packages/ui`; project
   rows are styled as flight strips; motion stays within ui-design-system.md §6 (no split-flap gimmicks,
   no confetti); the simulated-data disclaimer is prominent (data-ethics.md §2), not buried.

## Alternatives considered

1. **Containerized Next.js runtime service** (`next start` behind Caddy) — topologically consistent but
   pays ~100–200 MB RAM and a health surface for a page with zero server-side behavior; static files
   need nothing. Rejected as unjustified runtime.
2. **Separate repository / separate hosting (e.g. GitHub Pages)** — breaks D-08 (one monorepo sharing
   infra patterns) and fragments the deployment story (ADR-0006: one VPS, Caddy front). Rejected.
3. **Non-Next static site generator** — a new build tool outside the locked stack (D-03) for no gain.
   Rejected.
4. **Single multi-project host with paths** (`aviation.ricothen.com/turnaround-iq/`) — contradicts the
   ADR-0006 hostname scheme ("CV links must never move"; no basePath/cookie coupling). Rejected.
5. **Full-screen JS-heavy showcase** — violates ui-design-system.md §6/§8 restraint; the page must load
   fast on a reviewer's first visit and survive with JS partially blocked. Rejected.

## Consequences

- (+) One CV-safe URL that frames all three systems and routes reviewers to live demos, case studies,
  and the traceability matrix.
- (+) Zero runtime cost; the landing survives demo-stack incidents (static files, independent of
  postgres/redis/next containers).
- (+) The page itself is CI-gated like every other workspace app (lint, strict typecheck, unit, build).
- (−) One deploy step beyond `git pull`: the built `out/` must be copied to the host's
  `infra/deploy/landing/` (documented in `infra/deploy/landing/README.md`); CI does not deploy.
- (−) Status badges are manually flipped in `src/lib/projects.ts` when the mro/rebook live deploys
  happen; the unit test keeps that file internally consistent but cannot detect real-world drift —
  updating it is part of each deploy's checklist.
- (−) `next/font` requires network at build time (already true for the other apps).

## Compliance

No new framework, database, runtime service, or vendor SDK (D-03). The Caddy site block and the
`infra/deploy/landing/` runbook are deployment artifacts of the locked stack, covered by this ADR in
the same way ADR-0006 covers the prod compose. All content is English (D-06); all claims trace to
committed reports (D-07); no real-company affiliation or logo (data-ethics.md).
