# UI Design System

| Field | Value |
|---|---|
| Status | Binding — generic or template-looking UI is a **defect**, not a style choice |
| Applies to | `packages/ui` + every app screen |

## 1. Design Language

**"Mission control, not admin panel."** Dark, calm, information-dense where it must be,
glanceable where it matters. The UI should feel like a real airport operations product
(a CAG/Airbus APOC screen), built with restraint.

## 2. Color Tokens

| Token | Value (dark theme) | Usage |
|---|---|---|
| `bg` | `#0B1220` | App background |
| `surface` | `#111A2C` | Cards, panels |
| `surface-raised` | `#1A2540` | Modals, drawers, popovers |
| `border` | `#24314F` | Hairlines, dividers |
| `text-primary` | `#E6EDF7` | Body text |
| `text-muted` | `#8A97AD` | Secondary text, labels |
| `accent` | `#38BDF8` (cyan) | Interactive highlights, selection, live indicators |
| `accent-warm` | `#F5A524` (amber) | Warnings, in-progress tasks, attention |
| `danger` | `#F31260` | Breached SLAs, conflicts, critical alerts |
| `ok` | `#30A46C` | Completed, healthy states |

- Semantic roles only in components — never raw hex outside `packages/ui/tokens`.
- WCAG AA contrast on all text/text-pairs; status colors never encode information alone (pair with icon + label).

## 3. Typography & Spacing

- Sans: `Inter` (or Geist Sans) for UI. Mono: `Geist Mono`/`JetBrains Mono` for timestamps, flight codes, KPIs.
- Scale: 12 / 13 / 14 / 16 / 20 / 24 / 32. Body 14. Tabular numerals for all metrics.
- Space scale: 4 / 8 / 12 / 16 / 24 / 32 / 48. Density: compact (ops tables) with 12px min touch targets for interactive elements.

## 4. Component Inventory (packages/ui)

Build these as the shared kit, generic and domain-parameterized:
`StatTile`, `StatusBadge`, `AlertCard`, `TimelineRow` (Gantt lane), `LiveClock`,
`DataDrawer` (right slide-over), `Tabs`, `KpiStrip`, `EventFeedItem`, `EmptyState`,
`ErrorState`, `Skeleton`, `ConfirmDialog`, `Toast`, `ScenarioPicker`.

## 5. Screen Archetypes (turnaround-iq)

1. **Command board** (default): top KPI strip → main split: left ⅔ turnaround timeline (Gantt), right ⅓ live event feed + alerts. Airport map toggle replaces timeline.
2. **Flight drawer**: flight header → task checklist with SLA countdowns → event history (audit) → replan panel.
3. **Scenario console**: scenario picker, injected disruptions, speed control (1×/5×/20×), reset.

## 6. Motion

- 150–250 ms ease-out transitions. Numbers animate via count-up only on KPI changes.
- Replan proposal: lanes glide to new positions (300 ms) with a brief amber→cyan pulse; never flash or shake.
- Live data appears with a subtle fade+slide; no bouncing, no confetti.

## 7. Mandatory States

Every data-bound surface implements all four: **loading** (skeleton matching final layout),
**empty** (explain + first action), **error** (explain + retry, preserve user input),
**live-updating** (visual freshness cue). Screens missing any state fail review.

## 8. Forbidden Patterns (hard fails)

1. Default framework look: unthemed shadcn/MUI/Ant defaults, Bootstrap blues.
2. "AI slop" aesthetics: purple-magenta gradients, glassmorphism-on-everything, emoji as icons, sparkles decoration on AI features.
3. Lorem ipsum, dummy names like "John Doe", inconsistent fake data (airlines that don't match flight numbers).
4. Charts without axis labels/units; tables without headers state.
5. Layout shift on live updates; scroll-jacking; alert fatigue (no un-dismissable modals for non-critical alerts).
6. Responsive as an afterthought: the command board must remain usable at 1280×720 (interviewer projector) and degrade sensibly to tablet width.
7. Claiming real companies: airline codes are fictional (e.g., `AX`, `TR-style invented code "NX"`) except generic references permitted by data-ethics.md.

## 9. Accessibility & Quality

- Keyboard navigable primary flows; visible focus rings; ARIA live region for incoming alerts.
- Storybook (or equivalent) story per component in `packages/ui` — doubles as visual documentation for reviewers.
- Every screen footer: "Simulated data for portfolio purposes" (data-ethics.md).
