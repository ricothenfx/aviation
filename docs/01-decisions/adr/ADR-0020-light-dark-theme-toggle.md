# ADR-0020: Light/Dark Theme Toggle — Semantic-Token Light Palette, Dark Remains the Default

| Field | Value |
|---|---|
| Status | **Accepted** (user requested in-session 2026-09-29: "cek di 3 projek ini sudah ada fitur button light/dark atau belum? jika belum ada, tambahkan") |
| Date | 2026-09-29 |
| Supersedes | — (extends ui-design-system.md §1/§2, which previously described a dark-only design language) |
| Related | D-03 (locked stack — no new dependency), D-07 (honesty), D-08 (one monorepo, shared design system), ui-design-system.md (updated by this ADR), ADR-0018 (visual regression + a11y gates re-baselined) |

## Context

All three project apps render exclusively in the mission-control dark theme
(ui-design-system.md §1/§2): `packages/ui/src/styles/theme.css` defines the token set on
`:root` via Tailwind v4 `@theme`, and no app ships any mechanism to switch palette — no
toggle exists in any of the three products. A user reviewing the portfolio on a bright
projector or in daylight asked for a light/dark switch on all three apps.

Constraints:

1. **No new dependency.** The obvious library (`next-themes`) is a new package outside the
   locked stack (D-03; tech-stack §3 vendor/SDK discipline). The mechanism needed is ~60
   lines of plain React + one inline script.
2. **The design language stays "mission control".** Dark is the review-endorsed identity
   (§1) and the deterministic baseline for CI (Playwright headless defaults to
   `prefers-color-scheme: light`, so an OS-preference default would make every visual
   baseline environment-dependent). Light is an opt-in, persisted choice.
3. **Accessibility gates already exist** (ADR-0018): axe-core asserts zero critical/serious
   violations, and committed `toHaveScreenshot()` baselines gate visual drift. A second
   palette must pass the same contrast bars the dark palette passes.

## Decision

1. **Dark remains the default theme** on every surface; light is opt-in via the toggle and
   persisted in `localStorage` key `aviation-theme` (shared key name across the three apps;
   apps run on distinct origins/ports so keys never collide). A first visit with no stored
   preference renders dark, independent of OS preference — keeping e2e/visual baselines
   deterministic (ADR-0018).
2. **Semantic tokens only, one extra token.** `packages/ui/src/styles/theme.css` gains an
   `html[data-theme="light"]` override block for the existing `--color-*` tokens, plus one
   new token `--color-accent-contrast` (the readable text color on an `accent` fill:
   near-black `#06121f` in dark, white in light). Components must use
   `text-accent-contrast` instead of the previously hardcoded `text-[#06121f]` on accent
   fills (`Button` primary, turnaround-iq flight strip selection). The light values keep
   WCAG AA (≥ 4.5:1) for every token used as text on `bg`/`surface`/`raised`, verified by a
   computed contrast check, not by eye.
3. **Status colors split by role, not by hue.** Where a status color is used as *text*
   (StatusBadge, ErrorState), the light palette darkens the token (`--color-accent
   #0369a1`, `--color-warn ≈ #9a5b0b`, `--color-ok #15803d`, `--color-danger-fg ≈ #c81e4e`);
   where it is used as a *fill with dark bar text* (vis-timeline bars, scenario-clock chip),
   turnaround-iq's app-owned vis theming overrides the light-theme fills as `color-mix`
   lightened variants so the shared dark bar text (`#06121f`) keeps its contrast. No
   component gains a second color set — only the token values change.
4. **Charts get a theme-aware literal palette.** `CHART_TOKENS` (used by Recharts, which
   needs literal colors) becomes `chartTokens(theme)` with committed dark and light values;
   a shared `useTheme()` hook re-renders chart components on toggle.
5. **ThemeToggle is a shared component** in `packages/ui` (client): sets
   `data-theme` on `<html>`, persists to `localStorage`, dispatches a window event that
   sibling `useTheme()` consumers listen to. Sun/moon are inline SVG icons (no emoji, §8;
   no icon library — none exists in the locked stack). A `<script>` snippet exported as
   `THEME_INIT_SCRIPT` runs before paint in each app's root layout (no-FOUC), with
   `suppressHydrationWarning` on `<html>` since the script mutates the attribute pre-hydration.
6. **Placement:** every root layout footer (all routes, including login) gets a toggle;
   the primary surfaces additionally get one in their always-visible header — turnaround-iq
   `BoardShell` header (the board scrolls the footer below the fold), mro-copilot and
   rebook-ai nav headers.
7. **Docs updated with the code** (user instruction outranks the dark-only standard):
   ui-design-system.md §1/§2 now documents the light token column and the toggle
   requirement; dark stays the named default.
8. **Visual baselines re-captured** per ADR-0018's deliberate-redesign path
   (`--update-snapshots`): the toggle adds pixels to header/footer captures. Axe gates must
   pass in the default dark theme unchanged, and the contrast check in (2) de-risks the
   light theme.

## Alternatives considered

1. **`next-themes`** — the standard Next.js theming library (class strategy, system
   preference, no-flash script). Rejected: a new package outside the locked stack (D-03) to
   replace ~60 lines we fully control; it also defaults to OS preference, which would make
   headless CI captures environment-dependent (ADR-0018 determinism).
2. **CSS `prefers-color-scheme` only (no toggle)** — zero-JS theming, but not what was
   asked: the user wants an explicit button, and media-query theming cannot be overridden
   by a per-user choice.
3. **Light as default via OS preference** — friendlier on bright projectors, but breaks
   deterministic visual baselines and demotes the review-endorsed mission-control identity
   (§1) to second place. Rejected; dark stays default, light is persisted opt-in.
4. **Per-app palettes** — three hand-rolled light themes would fragment the shared design
   system (D-08). Rejected: one token override block in `packages/ui`, all three apps
   inherit it.

## Consequences

- Every screen in all three apps is theme-swappable with zero per-component color forks;
  new components stay theme-safe as long as they use semantic tokens (the only escape
  hatch is `text-accent-contrast` on accent fills).
- The light palette's AA ratios for text roles are pinned by a computed contrast check at
  decision time; future token edits must re-verify the same pairs.
- CI visual baselines are re-captured once for the added toggle pixels; theme is
  deterministic (dark) in CI, so no per-theme baseline sets are needed.
