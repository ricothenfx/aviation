# Continuous Demo Run — F5 (F-1…F-7 in one uninterrupted session)

| Field | Value |
|---|---|
| Status | Executed 2026-09-26 ~05:10–05:15 UTC against the live compose stack (`mro-web` :3003, production build) |
| Executor | `scripts/screenshots/mro-f5.mjs` (Playwright) — the script performs the flow in one browser session; screenshots are the per-step evidence |
| Purpose | milestones.md §F5 DoD: "All PRD in-scope features F-1…F-7 demonstrable in one continuous run" |

## The run, in order (no state was reset between steps)

| Step | Feature (PRD) | What happened | Evidence |
|---|---|---|---|
| 1 | F-1 Manual library | Engineer (`siti.rahayu@`) logs in; manuals library renders 62 NX-320 docs (AMM/IPC/TSM/SB, ATA structure, revisions) | `assets/f5-01-manuals-library.png` |
| 2 | F-2 Hybrid search | Query "hydraulic accumulator torque" → hybrid results with revision-traceable snippets | `assets/f5-02-search-hybrid.png` |
| 3 | F-3 Grounded ask | Same session asks the torque question → answer with grounding 0.791, `source: llm · provider: mock` disclosed, citations [1][2][3] (task card, ATA 29, page + rev) with "Open in manual browser" deep links; draft awaiting sign-off | `assets/f5-03-ask-grounded.png` |
| 4 | F-3 Honest refusal | Off-corpus question (winglet paint spec) → explicit refusal, no fabricated answer | `assets/f5-04-ask-refused.png` |
| 5 | F-4 Sign-off (separation of duties) | Engineer logs out; reviewer (`wei.lim@`) logs in, opens review queue, approves the draft with note → verified library | `assets/f5-05-review-queue.png`, `assets/f5-06-approved-library.png` |
| 6 | F-5 Engine health | `score-fleet` triggered (idempotency-keyed); fleet dashboard (provenance strip v1.0.0 + sha, tiles, alert queue incl. NX-E202 lead-cycles fixture); unit trend ±1.96σ band | `assets/f5-07-fleet-dashboard.png`, `assets/f5-08-unit-trend.png` |
| 7 | F-6 Evaluation | Eval history shows the F5 full run green (recall@5 92.3%, refusal 100%, citation validity 100%, grounded 84.6%) plus persisted run history | `assets/f5-09-eval-history.png` |
| 8 | US-10 / FR-5 ingest | Reviewer triggers re-ingestion from the new ingest panel → `completed · new 0 · changed 0 · unchanged 630 · removed 0` (idempotent no-op with evidence rows; first-boot ingest row from 25/09 visible below it) | `assets/f5-10-ingest-panel.png` |

RBAC (F-6/F-7 surface) is exercised structurally by the same run: steps 1–4 run as
engineer (no approve rights), steps 5–8 as reviewer (approve + eval + ingest only) —
the UI renders the role-gated actions accordingly, and the server-side ladder is
covered by the RBAC integration matrix.

## Honest notes

- The review queue in the screenshots also contains drafts created by integration-test
  runs earlier the same day; the continuous run approved the torque-question draft —
  the flow does not depend on queue contents.
- All numbers visible in the screenshots match the committed reports
  (final-eval-report-f5.md, load-report-f5.md); the corpus digest
  `c8f16cf6ed49…` is identical across eval and ingest evidence because the corpus
  is deterministic.
