# mro-copilot — Milestone Report: F3 (RAG Copilot, Guardrails & Sign-off)

| Field | Value |
|---|---|
| Milestone | F3 per `docs/04-projects/mro-copilot/milestones.md` §F3 |
| Status | **Complete** — Definition of Done met (evidence below) |
| Scope guard | Stack unchanged (D-03/ADR-0003/ADR-0010/ADR-0012); no PRD OUT-OF-SCOPE item built |
| Commits | `feat(mro)`/`test(mro)`/`fix(mro)` conventional commits, `mro` scope, pushed to `origin/main` |
| CI | All GitHub Actions workflows green on `origin/main` (mro unit + python + compose gates, e2e turnaround + **mro**) |

## What shipped

1. **Ask flow end-to-end** (PRD FR-9, architecture.md §3, ADR-0012 §3):
   `POST /api/v1/ask` (RBAC engineer+) runs hybrid retrieval (top-k=8 via the
   ai-service) → guardrail pre-check → prompt assembly (TS app) →
   `packages/llm-gateway.complete` (mock provider default) → citation
   post-check → persisted `draft` + citations + stage-timed structured logs.
   `Idempotency-Key` replay is backed by a PostgreSQL table (FR-2; mro has no
   Redis per architecture.md §1) — replay verified on the wire by the full
   eval.
2. **Grounding-quality signals in retrieval** (additive, api-contracts.md §1
   addendum): `SearchHit` carries `vectorScore` (query-chunk cosine, null in
   lexical mode) and `termCoverage` (query-lexeme coverage of the chunk's
   tsv), both computed in the SAME single SQL round trip in ai-service. They
   never affect ranking — they exist so the guardrail can refuse on a
   calibrated, meaningful signal (see Deviations §1 for why the fused RRF
   score alone was insufficient).
3. **Refuse-when-ungrounded** (FR-10, architecture.md §3 step 3): the app
   refuses WITHOUT calling the LLM when the grounding score is below the
   calibrated threshold; refusals are persisted (terminal status) with
   `source: "none"` and the machine-readable reason, and carry NO
   `answer`/`citations` fields (behavioral contract api-contracts.md §4,
   wire-asserted in integration tests).
4. **Citation validity + honesty** (FR-11/FR-12, ADR-0012 §4): citation
   markers `[n]` are validated against the retrieved set — hallucinated
   markers are stripped from the presented text; an answer whose markers are
   all invalid downgrades to refusal (`no_valid_citations`). Source labels:
   mock LLM ⇒ `source: "llm", provider: "mock"`; provider unavailable ⇒
   verbatim extractive fallback (`source: "extractive"`, `provider: "none"`)
   proven end-to-end against a REAL provider-off web container (LLM_PROVIDER=
   off, isolated `NEXT_DIST_DIR` build), mirroring the F2 degradation-ladder
   precedent. Citation `[n]` markers render as clickable links into the
   manual browser at the cited chunk.
5. **Mock provider grounded synthesis** (packages/llm-gateway, ADR-0003):
   additive completion mode — prompts carrying numbered `[n]` context blocks
   produce a deterministic cited answer lifted from the best-matching blocks;
   zero overlap ⇒ honest `NOT COVERED` with no markers (drives the refusal).
   The legacy deterministic echo is unchanged — turnaround-iq suites pass
   untouched.
6. **Answer lifecycle + separation of duties** (FR-14, architecture.md §5):
   `draft → approved | rejected` transitions are reviewer-only;
   `SELF_APPROVAL_FORBIDDEN` blocks an author approving their own answer even
   with the reviewer role; reject requires a note (400 otherwise);
   non-draft transitions are 409 `LIFECYCLE_CONFLICT` (additive error code,
   api-contracts.md §2 addendum). Every transition is an append-only
   `audit_events` row — UPDATE/DELETE are blocked by a database trigger
   (migration 0002), asserted by an integration test that executes both.
7. **Verified-answer library + role-scoped visibility** (FR-15): approved
   answers form the library; visibility viewer = approved only, engineer +=
   own, reviewer = all. Detail view replays the lifecycle from audit events.
8. **Review queue UI** (US-6, ui-design-system §5/§7/§8): drafts with answer
   and citations side-by-side, verify links into the manual browser,
   approve, reject with mandatory-note validation; ask panel renders drafts
   (source badge, provider disclosure, grounding score, retrieval mode incl.
   degraded flag) and refusals as a first-class honest outcome. New Answers
   + Evals screens; all mandatory states (loading/empty/error+requestId) and
   the persistent simulated-data footer. Screenshots:
   `assets/f3-ask-draft.png`, `assets/f3-ask-refusal.png`,
   `assets/f3-review-queue.png`, `assets/f3-answers-library.png`,
   `assets/f3-evals-history.png`.
9. **Eval full mode + persistence** (FR-20/FR-21, data-model.md §9):
   `pnpm eval:mro:full` drives the PUBLIC endpoints (`/api/v1/search`,
   `/api/v1/ask`) and gates recall@5 ≥ 0.85 · refusal accuracy = 100%
   (status AND machine reason AND refusal integrity) · citation validity =
   100% (every citation resolves via the manuals API) · grounded rate ≥ 80%,
   then persists the run through `POST /api/v1/evals` (reviewer principal)
   and writes JSON+MD reports. `GET /api/v1/evals[/{runId}]` +
   `eval_runs` table power the reviewer eval dashboard (`/evals`).
10. **Calibration as evidence** (data-model.md §9): `GROUNDING_MIN_SCORE`
    (hybrid, `0.6·termCoverage + 0.4·vectorScore ≥ 0.70`) and
    `GROUNDING_MIN_COVERAGE` (lexical, 0.70) trace to the committed run
    `eval-reports/grounding-calibration.json` (regenerate via
    `scripts/eval-mro/calibrate-threshold.mjs`).
11. **CI**: mro.yml compose job gains the full-eval gate + ask-latency gate
    (`pnpm bench:mro-ask`, p95 < 2.5 s); e2e.yml gains a `playwright-mro`
    job (fresh compose stack: login → ask → citation into manual browser →
    reviewer approve → verified library + audit; refusal card; reject
    flow). AGENTS.md §5 commands updated (`eval:mro:full`, `bench:mro-ask`,
    `test:e2e:mro`).

## Definition of Done — evidence

| DoD item (milestones.md §F3) | Evidence |
|---|---|
| Refusal tests: below-threshold ⇒ `status: refused` + reason, NO answer/citations; refusal-set accuracy = 100% in CI eval | `tests-integration/ask-signoff.test.ts` (key-absence assertion, persistence with `source: "none"`); full eval refusalAccuracy = **1.0** over 22 cases (reason match + integrity), gate step in mro.yml; UI refusal card `assets/f3-ask-refusal.png` |
| Citation-validity tests: hallucinated citation stripped; zero valid ⇒ refusal — 100% (FR-11) | `src/lib/rag/engine.test.ts` (parse/check/strip/zero-valid); route wiring in `src/app/api/v1/ask/route.ts`; full eval citationValidity = **1.0** (132/132 citations resolve via the public manuals API) |
| Full eval gates green in CI: recall@5 ≥ 0.85 · refusal 100% · citation validity 100% · grounded ≥ 80% | Latest run (final build): **recall@5 0.9231 · refusal 1.0 · citation validity 1.0 · grounded 0.8462 — PASS**, persisted as eval run `c685d335-cc2d-4e6a-9930-4bde882d9eca`; reports `eval-reports/full-v1.{json,md}` committed; mro.yml step "Full eval gate" |
| Source-labeling tests: mock ⇒ `source:"llm", provider:"mock"`; provider off ⇒ extractive labeled; UI badge renders both | Integration `ask-signoff.test.ts` (llm/mock) + `extractive-fallback.test.ts` (boots a real provider-off web container; verbatim-concatenation contract asserted against the DB chunk content); e2e badge assertion; screenshots `f3-ask-draft.png` (llm badge) |
| Sign-off integration tests: approve/reject transitions, mandatory note on reject, SELF_APPROVAL_FORBIDDEN, append-only audit | `tests-integration/ask-signoff.test.ts` (role gate 403, self-approval 403 + code, double-approve 409 LIFECYCLE_CONFLICT, reject note 400/200, audit order + DB-level UPDATE/DELETE rejection via trigger) |
| Ask p95 < 2.5 s with mock provider on compose stack — measured, logged | `pnpm bench:mro-ask`: **p95 234.1 ms, p50 74.0 ms, p99 396.6 ms, 0 errors** over 100 sequential end-to-end asks (0.3 GB corpus scale, 8-core host); `eval-reports/ask-latency.json`; gate step in mro.yml |
| E2E (Playwright): login → ask → citation into manual browser at cited chunk → reviewer approves → verified library | `apps/mro-copilot/e2e/ask-signoff.spec.ts` — 3 specs green (full lifecycle incl. audit replay, refusal, reject-with-note); `playwright-mro` job in e2e.yml on a fresh stack |
| Design-system review §5/§7/§8 passes for ask panel + review queue (screenshots) | `assets/f3-ask-draft.png`, `f3-ask-refusal.png`, `f3-review-queue.png`, `f3-answers-library.png`, `f3-evals-history.png` — loading/empty/error(+requestId) states implemented in every screen; simulated-data footer persistent |

Also green: retrieval eval re-run (`recall@5 0.9231, MRR 0.8458`) and search
latency gate (`p95 156 ms < 300 ms`) — F2 gates unaffected; unit suites
(mro 29, llm-gateway 10, turnaround 19 + domain 37 + contracts 13), python
gate (ruff · ruff format · mypy strict · pytest 43 passed), integration
suite 57 passed (9 files).

## Document sections that guided major choices

- `milestones.md` §F3 scope + DoD; §Handoff Protocol (report → push every
  step → green workflows).
- `architecture.md` §2 (RAG orchestration, guardrails, sign-off state
  machine live in the TS app; ai-service owns embeddings/retrieval only),
  §3 (ask flow steps 1–6 incl. refusal-before-LLM and citation post-check),
  §4 (retrieval design, degradation ladder), §5 (RBAC + separation of
  duties), §6 (provider unavailable ⇒ extractive fallback).
- `api-contracts.md` §1 (endpoint inventory and exact response shapes; eval
  CLI drives public endpoints), §2 (error envelope + additive mro codes),
  §4 (refusal integrity, citation validity, source-honesty ⟺ verbatim,
  additive evolution).
- `data-model.md` §1/§2 (answers, answer_citations `(answer_id, seq)`
  unique, append-only audit_events, eval_runs), §5 (chunk provenance that
  citations render), §9 (fixture versioning + threshold-calibration
  discipline — "thresholds are evidence, not vibes").
- `PRD.md` FR-9..FR-15, FR-19..FR-21, US-3..US-7, §7 (success metrics incl.
  grounded definition with the mock provider).
- ADR-0003/D-10 (provider-agnostic gateway, labeled degrade paths),
  ADR-0012/D-18 (TS app owns RAG orchestration; gateway parity),
  D-09 (seeded users, server-side RBAC).
- `ui-design-system.md` §5/§7 (mandatory states), §8 (forbidden patterns),
  §9 (no raw HTML, footer).
- `data-ethics.md` (visible simulated-data labeling on every screen).
- AGENTS.md §3 (quality gates, honesty) and §5 (commands kept current).

## Deviations & honest notes

1. **The fused RRF score alone is NOT a workable grounding threshold —
   measured, then extended additively.** Calibration against the fixtures
   showed the refusal set's top-1 fused score equals the golden minimum
   (both 1/61 ≈ 0.0164: one lexical rank-1 hit), so no threshold on that
   score can satisfy refusal 100% + grounded ≥ 80%. Query-chunk cosine alone
   also overlaps (refusal max 0.64 vs golden min 0.31 — the mock char-n-gram
   embedder is weak by design, ADR-0012). The shipped signal blends
   `0.6·termCoverage + 0.4·vectorCosine` (both computed inside the existing
   single retrieval SQL statement; additive response fields). Chosen
   thresholds (0.70/0.70) give refusal catch 22/22 and golden grounded
   84.6% with a ~0.02–0.04 margin on the boundary cases; the committed
   calibration report documents the candidate grid. Consequence: degraded
   (lexical) mode now also refuses on a calibrated bar instead of a guess.
2. **Contract addenda are additive only** (api-contracts.md §1/§2 updated in
   the same commits): `SearchHit` += `vectorScore`/`termCoverage`; ask
   `source` += `"none"` (a refused answer has NO generation source — honest
   labeling beats forcing `llm|extractive`); error codes +=
   `LIFECYCLE_CONFLICT` 409. No existing field changed meaning; the shared
   cross-runtime fixture was updated and both pydantic and zod parity tests
   pass.
3. **Mock grounded synthesis lives in packages/llm-gateway** (not the app):
   the gateway owns "realistic response shape" for the offline provider;
   the behavior keys off the generic numbered-context prompt shape, not mro
   domain logic (architecture.md §2 boundary kept). Legacy echo behavior is
   byte-identical — turnaround-iq's copilot suites pass unchanged.
4. **Mock answer prose includes chunk breadcrumbs** (the §5 breadcrumb is
   part of chunk content, and the deterministic extractor lifts real
   sentences from it). Honest but not pretty — the mock provider is
   explicitly a deterministic stand-in (ADR-0003); a real provider swap
   changes prose quality without contract changes.
5. **`POST /api/v1/admin/ingest` remains DEFERRED** (the F2 flagged gap):
   F3's reviewer-facing scope is the review queue/sign-off — none of its
   flows need a corpus re-ingest trigger, and no F3 DoD item references it.
   It stays deferred for F5 (live-demo ops need it: fresh-ingest before the
   recording; PRD US-10 ingest-status UI). Explicitly not silently dropped.
6. **Eval-run persistence authenticates as the seeded reviewer principal**
   (api-contracts.md §1 says "reviewer+ (service account)"). The D-09 model
   has no separate service-account user type; the CLI logs in with the
   reviewer seeded credentials (env-overridable). A dedicated service
   account user would be a D-09 extension — flagged if the user wants it.
7. **Eval dashboard scope**: the reviewer read-only run history screen
   (`/evals`) shipped because the eval endpoints + persistence landed with
   F3 and the placeholder itself was marked "F3+"; per-case drill-down
   stays minimal (gates + pass/fail; case summaries in the persisted run).
8. **Idempotency replay is PG-backed and sequentially safe** (store-then-
   return with a unique PK; a same-key race lets both callers execute — the
   same property as turnaround-iq's Redis implementation). PRD FR-2's
   "safe on retry" is the requirement; concurrent duplicate submission is a
   different (harder) problem that remains out of scope for both projects.
9. **Local e2e runs tolerate eval/bench-created answers**: lifecycle
   assertions are count-deltas (CI runs on a fresh compose stack where the
   counts are absolute). This keeps the suite honest under a polluted dev
   database without weakening what it asserts.

## Verification log (local, pre-push)

- `pnpm lint` (prettier --check + eslint --max-warnings 0) — clean across
  the workspace; `pnpm typecheck` (strict, now including e2e specs) — clean.
- Unit: mro-copilot 29 · llm-gateway 10 · turnaround-iq 19 (+ domain 37,
  contracts 13) — all pass.
- Python gate in the pinned image (ruff check · ruff format --check · mypy
  strict · pytest): 43 passed, 1 skipped (docker-conditional).
- `pnpm --filter mro-copilot test:integration`: **57 passed** (9 files)
  against the compose stack — including the real provider-off extractive
  container and the DB-level append-only trigger assertions.
- `pnpm eval:mro` → recall@5 0.9231 (gate ≥ 0.85) PASS;
  `pnpm eval:mro:full` → all four gates PASS, run persisted;
  `pnpm bench:mro-search` → p95 156 ms (gate < 300 ms) PASS;
  `pnpm bench:mro-ask` → p95 234.1 ms (gate < 2.5 s) PASS.
- Playwright e2e: 3/3 specs pass against the compose stack.
- GitHub Actions: pushed to `origin/main`; mro.yml (python + compose gates
  incl. full eval + ask latency) and e2e.yml (turnaround + playwright-mro)
  watched to green (link in final handoff note).
