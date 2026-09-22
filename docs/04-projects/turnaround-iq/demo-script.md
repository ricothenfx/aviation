# TurnaroundIQ — Demo Script (90 seconds)

| Field | Value |
|---|---|
| Status | Approved |
| Purpose | Video recording + live interview walkthrough; dual narrative per D-01 (technical & non-technical reviewers) |

## Setup (before recording)
1. `docker compose --profile turnaround up -d && pnpm seed` → scenario "Reference Day — afternoon bank".
2. Login as `coordinator` (demo user). Browser 1280×720, dark theme, board view.
3. Disruption script loaded: "Loader 12 breakdown at 14:32" (47-minute baseline delay outcome when unmanaged).

## Shot List

| # | Time | Action | Screen | Narration — non-technical track | Narration — technical track |
|---|---|---|---|---|---|
| 1 | 0:00–0:10 | Board loads, turns tick live | Command board | "This is every aircraft turnaround on the stand, live — the screen a coordinator never had." | "Next.js board fed by a WebSocket gateway projecting from an append-only event log — sub-second freshness." |
| 2 | 0:10–0:20 | Inject disruption | Scenario console | "A baggage loader breaks down — watch what the system does before humans even notice." | "Disruption is an injected event; the same event sourcing path as real operations — replayable, auditable." |
| 3 | 0:20–0:35 | Alert appears, flight lane turns amber→red | Board + alert card | "Ten minutes before this becomes a delay, the system already knows — and says so." | "Rule engine projects SLA breach from the projection state; alert carries 10+ min lead time, lifecycle tracked." |
| 4 | 0:35–0:50 | Click replan → plan diff slides in | Flight drawer + replan panel | "One click. The AI re-sequences every remaining task and shows the plan: 47 minutes of delay becomes 9." | "Constraint scheduler minimizes total delay subject to dependencies, unit availability, fuel-boarding overlap — the LLM only explains the plan, humans approve it." |
| 5 | 0:50–1:00 | Approve → tasks glide to new slots; KPI strip updates | Board + KPI strip | "The coordinator stays in charge. The airport keeps its promises." | "Approval emits events; projections and KPIs are derived state — same audit trail answers 'why was this flight late'." |
| 6 | 1:00–1:15 | Open flight drawer, event history | Drawer | — (b-roll) | "Full event history per flight — this is the post-mortem view auditors ask for." |
| 7 | 1:15–1:30 | Grafana dashboard flash + repo shot | Observability | "Built like production: monitored, tested, deployed." | "Prometheus metrics, load-tested at 10× scenario scale; CI runs unit, integration, contract, and e2e suites." |

## Live-Interview Adaptation (5-minute version)
1. Let the interviewer pick the disruption (console makes it interactive).
2. Pause after step 4 and open the drawer: walk the audit trail (their question usually lands here).
3. Close on the README "mapped to JD requirements" table — connect product to their stack explicitly.

## Honesty Guards (data-ethics.md)
- Disclaimer visible in footer at all times; fictional airline codes only.
- Numbers quoted (47→9, <2 s, <1 s p95) must match the committed benchmark outputs at recording time.
- If asked "is this real data?": answer plainly — synthetic by design, generator is in the repo.
