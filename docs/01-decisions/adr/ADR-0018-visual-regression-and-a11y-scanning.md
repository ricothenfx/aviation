# ADR-0018: Automated Visual Regression + Accessibility Scanning in the E2E Suites

| Field | Value |
|---|---|
| Status | Accepted (2026-09-27, post-F5 hardening wave; requested and approved by the user in the live session) |
| Date | 2026-09-27 |
| Supersedes | — |
| Related | D-24, D-03, ADR-0007 (precedent for recorded tech-stack §3 exceptions), ui-design-system.md §8.6 + §9, engineering-standards.md §3, data-ethics.md §2 |

## Context

All three apps ship functional Playwright e2e suites in CI (login → core journey per
app), and turnaround-iq has a visual **smoke** spec that captures screenshots as
review evidence (F4 DoD). Two gaps remain against the user's goal — "the frontend must
be beautiful and every function must work, verified automatically":

- Screenshots are **never compared** — a regression that rearranges a layout, breaks
  contrast or drops a design-system token renders fine in tests and is only caught by
  a human re-reviewing images by hand.
- **Accessibility is unverified** — keyboard access is asserted once (tiq drawer), but
  nothing scans for WCAG violations (contrast, ARIA, labels) on any page.

## Decision

1. **Visual regression via Playwright's built-in `toHaveScreenshot()`** — committed
   per-app baselines for the key stable screens (tiq: login + board at a paused
   scenario state; mro: login, ask, search, engines, reviews; rebook: login, trip,
   console, supervisor), run as an additional spec inside each app's existing e2e
   suite and CI lane (no new workflow). Flake controls, in order of preference:
   capture at a **stable/paused state** (tiq board: scenario started but clock held —
   live boards are never pixel-stable mid-simulation), **disable animations**
   (`animations: "disabled"`), **mask** inherently dynamic regions (clocks, relative
   timestamps), and a generous `maxDiffPixelRatio: 0.02` to absorb cross-runner font
   antialiasing. CI installs browsers via `playwright install --with-deps chromium`
   (already the case), keeping font packages consistent.
2. **Accessibility scanning via `@axe-core/playwright`** — a new dev-only dependency
   (recorded exception to tech-stack.md §3, same mechanism as ADR-0007: scoped to the
   test layer, never runtime). Each app's suite gains a scan spec over its key pages
   asserting **zero `critical` or `serious` violations** on the scanned set; moderate
   and minor findings are written to the run log as a follow-up backlog, not gates.
   Violations found on the existing UI at introduction are fixed in the same change
   where small (labels, contrast tokens, ARIA roles), or explicitly recorded in the
   scan spec's allowlist with a reason — an allowlist entry without a written reason
   is treated as a test defect.
3. **The human "is it beautiful" judgment stays human, once** — automation guards the
   *baseline* the design system establishes; a deliberate redesign re-baselines
   snapshots via `playwright test --update-snapshots` in the same PR as the redesign.

## Alternatives considered

1. **SaaS visual-regression platforms (Percy/Chromatic)** — rejected: external service,
   account and cost outside the locked stack; Playwright's built-in diff covers the
   need at zero infrastructure.
2. **Pixel-perfect assertions on live boards** — rejected: simulation data changes
   every tick; masking the entire data area would reduce the assertion to chrome-only
   and the flake budget to zero. Paused-state capture keeps the data area meaningful.
3. **Full WCAG gate (all severities, all rules)** — rejected for the first wave: it
   would couple the suite to axe's complete rule catalog including opinionated
   `moderate`/`minor` findings, turning the gate into a backlog dump. Critical+serious
   now, logged lower severities for follow-up, is the honest incremental gate.
4. **Status quo (manual review only)** — rejected: does not scale to three apps and
   every future change; the user explicitly asked for maximum automation.

## Consequences

- (+) Unintended UI changes fail CI with a pixel diff; intentional ones re-baseline
  visibly in review.
- (+) Contrast/label/ARIA regressions become CI failures instead of interview-day
  surprises; the a11y story becomes a defensible talking point (axe in CI).
- (−) Baselines are per-platform PNGs — first CI run after this change may need one
  baseline refresh if runner fonts differ from the generating host; `maxDiffPixelRatio`
  absorbs antialiasing, not layout differences (which should fail).
- (−) Snapshot re-baselines add a small review duty to UI PRs (`--update-snapshots`
  diff must match the described change).
- (+/−) The axe devDependency is the second recorded exception to tech-stack §3
  (after ADR-0007) — test-scoped, version-pinned, and never imported by app code.
