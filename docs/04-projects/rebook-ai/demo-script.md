# Rebook.ai — Demo Script (90 s)

| Field | Value |
|---|---|
| Status | Draft v1 (F0); recorded at F5 |
| Cast | Fictional carriers only: NX NordicX, SV Sentosa Air, BH Blue Harbor Air (data-ethics.md §2). Every screen shows "Simulated data for portfolio purposes". |
| Beat target | Cancellation → new boarding pass ≤ 90 s wall clock (PRD §5) |

## Cast & Setup

| Role | Seeded user |
|---|---|
| Passenger (gold tier) | `nadia.cho@pax-sim.example` |
| Duty agent | `amir.hassan@nx-sim.example` |
| Duty supervisor | `grace.tan@nx-sim.example` |

Scenario: **NX 288 (SIN → AMS, long-haul) cancelled** on the reference day; Nadia Cho is
booked in the affected cabin on PNR `NXQ4ZK`.

## Beat Sheet (90 s)

| t | Beat | What it proves |
|---|---|---|
| 0–8 s | Supervisor console → inject `cancellation` on NX 288; agent queue populates; passenger inbox receives the disruption notification | Proactive notification (F-1), live queue (F-4) |
| 8–20 s | Switch to passenger view: notification + 3 ranked offers (fast = SV/BH interline-style connection arriving earliest; cheap = same-carrier later departure, fee waived; flexible = refundable option), voucher auto-issued (long-haul cancellation) | Ranked offers + reasons (F-2), auto voucher (F-3), explainable policy |
| 20–30 s | One-tap confirm on `fast` (interline) → honest note: interline needs supervisor approval; saga opens | Idempotent confirm, RBAC gate (F-7), saga open (F-6) |
| 30–50 s | Agent console: request proposal for the same PNR → agent loop trace (`search_routings → price_itinerary → check_policy`), `source: llm / provider: mock` badge; approve (supervisor) | Agentic workflow propose-only (F-5), human approval, audit |
| 50–70 s | Saga steps advance live: seat reserved → payment authorized (simulated PSP, labeled) → ticket issued; passenger sees the new itinerary + boarding pass | Saga completion + compensation safety story (F-6) |
| 70–80 s | Bonus honesty beat: inject a payment failure on a second PNR → compensation runs, passenger returns to queue with truthful state | Failure handling (architecture §6), metrics honesty (D-07) |
| 80–90 s | Agent queue shrank (containment tile); audit trail view answers "who decided what for whom, when" | Self-serve containment (PRD §5), auditability (F-7) |

## Narration Guardrails

- Say "fictional airline" and "simulated" explicitly at the start; never imply a real
  carrier/airport or a real deployment (data-ethics.md §3).
- LLM beats run on the deterministic mock provider; the badge says so. State that a real
  provider is config, not code (ADR-0003).
- Numbers shown (latency, containment) come from the committed harness — no invented claims (data-ethics.md §4).
