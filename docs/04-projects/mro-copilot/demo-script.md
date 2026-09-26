# MRO Copilot — Demo Script (90 seconds)

| Field | Value |
|---|---|
| Status | Ready — beat sheet committed; **recording + hosting are human steps** (flagged below, not faked) |
| Purpose | Video recording + live interview walkthrough; dual narrative per D-01 (technical & non-technical reviewers) |
| Live URL | `https://mro-copilot.aviation.ricothen.com` — **pending deploy** (infra/deploy/mro/README.md); local fallback: `docker compose --profile mro up -d` → `http://localhost:3003` |

## Setup (before recording)

1. `docker compose --profile mro up -d --wait` → stack self-installs, migrates
   (pgvector + hypertable), seeds users, ingests the corpus, loads the RUL
   artifact. Verify: `curl :3003/healthz` and `:3003/readyz` (postgres /
   pgvector / model / provider all `"up"`).
2. Login as reviewer `wei.lim@mro-sim.example` / `reviewer-nx-01` (sign-off +
   eval + ingest need reviewer). Browser 1280×720. Simulated-data footer must
   be visible in every shot (data-ethics.md).
3. Pre-flight one grounded ask and one refusal so cached routes are warm.
4. Numbers to quote live (verify against `docs/04-projects/mro-copilot/final-eval-report-f5.md`
   before recording): recall@5 **0.9231**, refusal accuracy **100%**, citation
   validity **100%**, grounded rate **84.6%**, RUL FD001 test RMSE **18.49**
   (≤ 24 gate), NASA score **786.5**. Latency claims: quote the honest
   envelope from load-report-f5.md, not a bare gate pass.

## Shot List

| # | Time | Action | Screen | Narration — non-technical track | Narration — technical track |
|---|---|---|---|---|---|
| 1 | 0:00–0:10 | Ask: *"What is the torque for the hydraulic accumulator attach bolts?"* | Ask panel | "Ask the manual a question in plain words — the answer comes back with the exact document, section, page and revision." | "Full RAG loop: hybrid retrieval — pgvector plus lexical, fused by RRF — prompt assembly constrained to retrieved chunks, mock provider disclosed." |
| 2 | 0:10–0:20 | Open the citation | Manual browser | "Every claim is clickable, down to the page — engineers trust what they can verify." | "Citation validity is enforced in code — every citation must resolve to a chunk actually retrieved; asserted at 100% by the eval." |
| 3 | 0:20–0:32 | Ask: *"What is the winglet paint specification for the NX-320?"* | Ask panel | "And when the manual doesn't cover it, it says so — no guessing in maintenance." | "Below the calibrated grounding threshold the copilot refuses with a machine-readable reason and emits no answer text — refusal integrity is CI-gated at 100%." |
| 4 | 0:32–0:45 | Reviewer approves the draft with a note | Review queue → verified library | "Nothing reaches the floor unreviewed — a senior engineer signs off every answer." | "Lifecycle `draft → approved`, reviewer-only, self-approval blocked, append-only audit — the verified library becomes the trusted cache." |
| 5 | 0:45–1:00 | Fleet dashboard: tiles, model strip, trend chart; open NX-E202 alert → acknowledge | Engine health | "The same system watches engine health: this unit is trending toward a shop visit inside the planned window — weeks of warning, not days." | "GBM trained on NASA C-MAPSS FD001 — test RMSE 18.49, tabled honestly against published baselines; every prediction carries model version + sha256; alerts fire with lead cycles and a strict lifecycle." |
| 6 | 1:00–1:15 | Eval dashboard: gates green; run history | Eval runs | "The system proves it works — these are numbers, not claims." | "Versioned golden-QA and refusal fixtures, CI-gated: recall@5 0.92, refusal 100%, citation validity 100%, grounded 85% — runs persisted for auditability." |
| 7 | 1:15–1:30 | Corpus ingest panel (reviewer): re-ingest → all unchanged | Evals page | "Even re-reading the whole manual library changes nothing unless content changed — by design." | "Ingest is idempotent by chunk content hash; re-ingestion is a no-op with full evidence rows — same discipline as the append-only audit." |

## Live-Interview Adaptation (5-minute version)

1. Let the interviewer pick the question (grounded vs off-corpus — the refusal sells the guardrail story).
2. Open the audit trail of an approved answer — their question usually lands here (who decided, when, which revision).
3. Show the traceability matrix §2 rows connecting their JD lines to code and tests.
4. If asked about scale: quote the load report honestly — verified envelope + documented host limitation, and what the fix was (ADR-0013).

## Manual human steps (flagged, not faked)

- **Recording** (the 90 s pass above) — human-performed; tooling suggestions:
  any screen recorder at 1280×720, one take per shot, cut on screen changes.
- **Hosting** — human-chosen (unlisted video link or on-request); no link may
  be fabricated in docs until it exists.
- **Live deploy** — infra/deploy/mro/README.md lists the three human steps
  (DNS record, secrets, Caddy co-location decision); everything else is
  committed and automatable.

## Honesty Guards (data-ethics.md)

- Simulated-data footer visible in every shot; C-MAPSS citation visible on
  engine-health screens.
- All quoted numbers must match committed evidence at recording time
  (final-eval-report-f5.md, load-report-f5.md, metrics.json).
- If asked "is this real data?": the corpus is hand-written fiction (NX-320),
  engine history derives from NASA's public C-MAPSS dataset, users are seeded
  demo accounts — the generator and seeds are in the repo.
