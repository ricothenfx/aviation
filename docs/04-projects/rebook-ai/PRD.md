# Rebook.ai — PRD

| Field | Value |
|---|---|
| Status | Approved — build target F1–F5 (user kickoff 2026-09-26; supersedes the 2026-09-22 skeleton) |
| Version | 1.0 (2026-09-26) |
| One-liner | Passenger disruption concierge: proactive rebooking offers in seconds, with an agentic workflow that optimizes cost vs. passenger experience under human agent supervision. |
| Target map | SIA/Scoot (Customer Experience, Application Developer — AOS), Amadeus, SITA, Sabre; CAG Commercial (see `docs/00-context/market-research.md` §3) |

## 1. Problem Statement

On an irregular operation (IROP) — cancellation, long delay, missed connection — passengers
queue at counters and call centers while agents re-accommodate them one by one with
DCS-era tooling. Every interaction is manual: re-searching flights, re-pricing fares,
checking policy eligibility, reissuing tickets.

1. **No proactive offer.** The passenger learns about the disruption standing in a queue,
   not seconds after it happens. Anxiety and counter load both peak.
2. **Re-accommodation is artisanal.** Each agent re-searches the same options for dozens
   of passengers on the same canceled flight; quality depends on who is on shift.
3. **Cost and experience are traded blind.** Cheapest option vs. fastest option vs. what
   the passenger actually values — no system ranks alternatives against policy and the
   passenger's fare/tier context, and compensation is applied inconsistently.

Outcome today: rebooking spend above policy, compensation paid inconsistently, churned
frequent flyers (acquisition costs 5–25× retention), and zero audit trail of who decided
what for whom.

## 2. Users & Jobs-to-be-Done

| User | Job-to-be-done |
|---|---|
| **Disrupted passenger** (primary) | "Tell me my options the moment my flight breaks — and let me fix it in one tap." |
| **Duty agent** (primary) | "Prepare the best rebooking decision for each remaining passenger — search, price, policy — so I only approve." |
| **Duty supervisor** | "Control the exceptions: high-cost and interline approvals, policy overrides, scenario control — with a full audit trail." |
| **Interviewer (demo persona)** | Understand the two-sided flow, see the agentic workflow work, and assess engineering quality — in under 10 minutes. |

## 3. In-Scope Features

| ID | Feature | Acceptance highlights |
|---|---|---|
| F-1 | **Proactive disruption notification** — in-app notification (SNS-shaped publisher abstraction, simulated delivery) within seconds of `flight.disrupted` | Notification + ranked offers visible p95 < 10 s after injection on the scenario clock |
| F-2 | **Ranked rebooking offers** — fast / cheap / flexible options per passenger, priced and policy-checked, with reasons for the ranking; one-tap confirm | Offers carry `reason` per rank; confirm is idempotent (`Idempotency-Key`); expired offers cannot be confirmed |
| F-3 | **Auto meal voucher** — when delay/cancellation criteria are met, a voucher is issued automatically with the offer set | Voucher rule outcome is explainable (criteria + evaluated values persisted) |
| F-4 | **Agent queue console** — live queue of disrupted passengers that shrinks as passengers self-serve; priority by tier/SLA | Queue updates live (< 1 s) via Redis pub/sub; served-by-self-serve passengers leave the queue with a visible containment metric |
| F-5 | **Agentic rebooking workflow** — agent loop over `packages/llm-gateway` (ADR-0003, Bedrock AgentCore-shaped tool loop) searches alternative routings incl. interline-style partners, applies policy/compensation rules, and prepares a decision proposal for human approval | The agent NEVER mutates booking state; proposals require agent/supervisor approval (role-gated); every proposal shows tool calls + rationale; degrade-to-rules when provider is off, honestly labeled |
| F-6 | **Saga fulfillment** — seat-reserve → payment → ticket-issue as a compensable saga (ADR-0014), idempotent, auditable | Duplicate confirm ⇒ no double charge (idempotency test); injected step failure ⇒ compensation runs and passenger returns to queue with honest state |
| F-7 | **RBAC + auth + audit** — seeded users; roles `passenger < agent < supervisor`; every decision append-only audited | Unauthorized actions blocked server-side; audit trail answers "who offered/confirmed/approved what, when" |

## 4. OUT OF SCOPE (binding — do not build)

- Real DCS/PSS/GDS integrations; real PNRs or real passenger data (synthetic only, data-ethics.md)
- Real payments — a simulated PSP stub with deterministic behavior stands in (labeled)
- Real email/SMS/push — in-app inbox only; the publisher interface is SNS-shaped (tech-stack.md §2)
- Native mobile apps; responsive web is the bar
- Multi-airline global inventory breadth — one fictional carrier (NX NordicX) + two fictional interline-style partners (SV Sentosa Air, BH Blue Harbor Air)
- Autonomous agent execution: the agent proposes, a human approves (PRD F-5) — never an unsupervised mutation path
- Refund/cash-compensation payouts beyond the voucher + fee-waiver policy rules
- i18n, user registration flows (seeded users only)

## 5. Success Metrics (demo-verifiable)

| Metric | Target |
|---|---|
| Disruption → notification + ranked offers (p95, scenario clock) | < 10 s |
| Agent proposal prepared (mock provider) | < 15 s, deterministic |
| Saga idempotency | Duplicate `Idempotency-Key` confirm ⇒ exactly one charge (CI test) |
| Saga failure containment | Injected payment failure ⇒ compensation completes, passenger state honest (CI test) |
| Self-serve containment (reference scenario) | ≥ 60% of disrupted passengers resolve via self-serve; queue visibly shrinks |
| 90 s demo | Cancellation → new boarding pass on the rebooked flight ≤ 90 s wall clock (demo-script.md) |

## 6. Domain Primer (for agents new to aviation)

- **IROP**: irregular operation — any event that breaks the published schedule (cancellation, long delay, diversion).
- **PNR**: passenger name record — the booking (passenger(s), itinerary, fare class, tier). Rebook-ai stores PNR-*like* synthetic records only.
- **Rebooking options**: `fast` (earliest arrival, any partner), `cheap` (lowest fare difference / fee), `flexible` (refundable/changes allowed, best for uncertain plans). Ranking weighs arrival time, fare delta, tier preferences, and policy caps.
- **Interline-style partner**: a second carrier whose segments can be combined onto one rebooked journey — simulated here with two fictional partners; no real interline agreements implied.
- **Fulfillment saga**: reserve seat inventory → authorize payment (fare difference/fee) → issue ticket + boarding pass. Any step can fail; completed steps must be compensated in reverse order.
- **Voucher criteria** (policy example): cancellation, or delay ≥ 3 h at departure — auto-issued with the offer set; rule evaluation is persisted for explainability.

## 7. References

- Requirement sources: `docs/00-context/market-research.md` §2–3 (SIA Customer Experience/AOS, Amadeus/SITA/Sabre, CAG Commercial); JD row mapping lands in `traceability-matrix.md` §3 at F5.
- Data rules: `docs/02-standards/data-ethics.md` (fictional airlines NX/SV/BH; visible "Simulated data" labeling).
- UI rules: `docs/02-standards/ui-design-system.md` (§5 archetypes extended for the two-sided console, §7 mandatory states).
- Platform: `docs/03-platform/tech-stack.md` (locked stack + AWS mapping row "notifications → SNS"), `ADR-0003` (LLM gateway), `ADR-0014` (orchestrator topology + saga), `ADR-0015` (PostgreSQL JSONB document store).
