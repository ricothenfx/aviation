# MRO Copilot — Data Model

| Field | Value |
|---|---|
| Status | Approved (user approval 2026-09-24) |
| Store | PostgreSQL 16 + **pgvector** (ADR-0010, D-16) + TimescaleDB (sensor history); **no Redis** for this project (architecture.md §1) |
| Database | `mro_copilot` (per-project DB, monorepo-architecture.md §3) |

## 1. ERD (core)

```mermaid
erDiagram
    MANUAL ||--o{ CHUNK : "is chunked into"
    MANUAL ||--o{ INGEST_RUN : "touched by"
    ANSWER ||--o{ ANSWER_CITATION : "cites"
    CHUNK ||--o{ ANSWER_CITATION : "cited by"
    ANSWER ||--o{ AUDIT_EVENT : "lifecycle of"
    ENGINE_UNIT ||--o{ SENSOR_READING : "produces"
    ENGINE_UNIT ||--o{ RUL_PREDICTION : "scored by"
    ENGINE_UNIT ||--o{ ENGINE_ALERT : "raises"
    USER }o--|| USER_ROLE : "has role"

    MANUAL {
        uuid id PK
        string doc_type "AMM|IPC|TSM|SB"
        string title "fictional NX-320 content"
        string ata_chapter "e.g. 29"
        string task_no "AMM/TSM: 29-11-00-000-401 style"
        string revision "e.g. Rev 37"
        date effective_date
        string status "active|superseded"
        string source_path "seed/manuals/**.md"
    }
    CHUNK {
        uuid id PK
        uuid manual_id FK
        string chunk_hash UK "sha256(manual+section+idx+content)"
        string section_path "breadcrumb heading path"
        int page "fictional page marker"
        int chunk_index
        text content "breadcrumb + body"
        int token_count
        vector embedding "vector(384), HNSW cosine"
        tsvector tsv "generated lexical column"
    }
    ANSWER {
        uuid id PK
        text question
        text answer_text "null when refused"
        string status "draft|refused|approved|rejected"
        string refusal_reason "below_grounding_threshold|no_valid_citations"
        string source "llm|extractive"
        string provider "mock|openai-compatible|bedrock-shape"
        numeric grounding_score
        jsonb retrieval_meta "{mode: hybrid|lexical, topK, latencyMs}"
        jsonb token_usage
        uuid created_by FK
        jsonb review "{reviewerId, note, at}" "on approve/reject"
    }
    ENGINE_UNIT {
        string unit_id PK "NX-E101 style, fictional"
        string dataset "cmapss-fd001"
        int window_threshold_cycles "maintenance-window threshold"
        string status "active|removed"
    }
```

## 2. Table Notes

| Table | Key columns & rules |
|---|---|
| `manuals` | `doc_type` enum; `(doc_type, task_no, revision)` unique; superseding a revision flips `status` explicitly (never deletes — FR-6); fictional branding only (data-ethics §2) |
| `chunks` | `chunk_hash` unique = idempotency key for re-ingest (FR-5); `embedding vector(384)` with **HNSW index** (`vector_cosine_ops`); `tsv` generated column with **GIN index**; `page` is the fictional page marker citations render |
| `ingest_runs` | corpus digest, chunk counts (new/changed/unchanged), embedding model id, status, report JSONB — the evidence for the idempotency DoD |
| `answers` + `answer_citations` | lifecycle `draft → approved \| rejected`, `refused` is terminal (architecture.md §3 ask flow); citation rows must reference chunks retrieved for that answer (validity invariant, enforced in code); `(answer_id, seq)` unique |
| `audit_events` | append-only (no UPDATE/DELETE grants to app role, mirrors turnaround-iq event_log discipline); types: `answer.created`, `answer.approved`, `answer.rejected`, `ingest.completed`, `alert.raised/acknowledged/resolved` |
| `engine_units` | seeded from C-MAPSS test split; `window_threshold_cycles` per unit (maintenance window); fictional `NX-E` identifiers (data-ethics §2) |
| `sensor_readings` (TimescaleDB hypertable) | `(unit_id, cycle)` unique; 3 operating settings + 21 sensor channels (`s1…s21`, C-MAPSS schema); `recorded_at` = deterministic mapping cycle → synthetic timestamp (data-model §8) |
| `rul_predictions` | `rul_cycles`, `band_low/high` (uncertainty), `model_version` (semver + artifact sha256 — predictions without provenance are a defect, FR-16) |
| `engine_alerts` | lifecycle `raised → acknowledged → resolved`; `lead_cycles` recorded at raise (≥ 5 in fixtures, FR-18) |
| `eval_runs` | fixture version, metrics JSONB (recall@5, MRR, grounded rate, citation validity, refusal accuracy), gates pass/fail JSONB, report path — powers the eval dashboard (F-6) |
| `users` | argon2id hash; role enum `viewer \| engineer \| reviewer` (D-09 pattern, ladder per PRD F-7) |

## 3. Redis Key Design

**None.** mro-copilot has no realtime projection layer; read paths are PG-backed queries
within the latency budgets (PRD §7). Adding Redis here would be infrastructure theater —
explicitly out of scope (architecture.md §1).

## 4. Corpus Structure (seed)

```
apps/mro-copilot/seed/
├── manuals/
│   ├── amm/            # task cards, ATA-chapter numbered (chapters 21, 24, 27, 29, 32, 34, 36, 49, 73…)
│   ├── ipc/            # figure/part lists per assembly
│   ├── tsm/            # fault-isolation tasks (fault code → procedure)
│   └── sb/             # service bullets (description / applicability / accomplishment)
├── cmapss/
│   ├── README.md       # provenance, citation, pinned download + sha256
│   ├── download.sh     # pinned URL + checksum verify → train/test/RUL CSVs (gitignored)
│   └── sample/         # committed 3-unit synthetic sample (clearly synthetic) for CI tests
├── eval/
│   ├── golden-qa.json  # §9
│   └── refusal-set.json
└── users.json          # seeded users (viewer/engineer/reviewer), per D-09
```

Target corpus: ~40 documents → **~600–900 chunks** (reference scale for all latency gates).
Markdown source of truth is the committed corpus; the DB is derived and rebuildable
(`ingest` is idempotent), so reviewers diff manuals in git, not in a DB.

## 5. Chunking Strategy (binding for the ingest CLI)

| Rule | Spec |
|---|---|
| Atomic unit | **AMM/TSM: one task card**; **IPC: one figure** (part rows of a figure stay together); **SB: one body section** (description / applicability / accomplishment) |
| Splitting | Cards > 450 tokens split at **step-block boundaries**; target 200–450 tokens, hard cap 500; overlap = repeat of the parent breadcrumb (below), not content duplication |
| Breadcrumb | Every chunk's content starts with the canonical heading path, e.g. `NX320 AMM · ATA 29 · 29-11-00 · Task 29-11-00-000-401 · Hydraulic reservoir pressurization` — feeds both the lexical and embedding legs, and renders in citations |
| Warnings travel with steps | A caution/warning note is never split from its parent step block |
| Metadata per chunk | doc type, ATA chapter, task/figure id, section path, fictional page, revision, effective date (rendered by every citation, FR-6) |
| Idempotency | `chunk_hash = sha256(manual_id + section_path + chunk_index + content)`; unchanged corpus ⇒ identical hash set + vector count (asserted by a CI test, PRD FR-5) |
| Supersession | Re-ingest with a new revision inserts new chunks and flips the old manual row to `superseded` — old answers' citations remain resolvable for audit (history is never rewritten) |

## 6. Volumes & Scale

- Corpus ≈ 900 chunks × (content + 384-dim vector ≈ 1.5 KB) ≈ **1.5 MB** — trivial for PG;
  honest scale statement, no pretending this is a web-scale ANN problem (ADR-0010).
- C-MAPSS FD001: train 20,631 cycles / 100 units; test 100 units → ~23k `sensor_readings`
  rows per seeded fleet copy (small, but real shape for the hypertable + compression story).
- `audit_events`, `answers`, `rul_predictions`, `eval_runs`: keep forever (audit and
  evidence are features). `sensor_readings`: Timescale compression after 90 synthetic days.

## 7. Migrations & Seed Discipline

- drizzle-kit migrations, forward-only, locked at F1 (engineering-standards §8);
  `CREATE EXTENSION vector` + HNSW/GIN indexes live in migrations, never ad-hoc.
- Seed order: users → manuals → ingest (embed) → engines → C-MAPSS sample/download →
  thresholds. One command per AGENTS.md §5 convention (`pnpm --filter mro-copilot seed`).

## 8. C-MAPSS Ingest & Time Mapping

- Seed provenance (`seed/cmapss/README.md`): the original `CMAPSSData.zip` is
  no longer fetchable without an interactive NASA portal, so `download.sh`
  pins the four FD001 source files **per file** from a documented public
  mirror of the NASA release, with sha256 verified on every fetch (tamper ⇒
  hard fail). Pin authenticity evidence: byte-equality across two independent
  mirrors + structure matching the published data card (train 20,631 rows /
  100 units; test 13,096 / 100; RUL 100). Files are gitignored; the committed
  `sample/` (3 synthetic units, clearly labeled, deterministic generator)
  keeps CI and offline dev hermetic (data-ethics §1).
- `recorded_at = EPOCH + cycle × 1 day` — **EPOCH = 2000-01-01T00:00:00Z**
  (fixed at F4), a **deterministic synthetic timestamp** enforced by a CHECK
  constraint so the hypertable, compression policy, and trend charts have a
  real, drift-free time axis; charts label it as synthetic time
  (ui-design-system §8: axes labeled). Hypertable requirement: unique
  constraints must include the partition column — uniqueness is
  `(unit_id, cycle, recorded_at)`, equivalent to `(unit_id, cycle)` because
  `recorded_at` is a pure function of `cycle`. Compression: chunks older than
  90 synthetic days (data-model §6).
- RUL training features are computed by ai-service from `sensor_readings`
  windows — the feature code that trains is the code that serves
  (ADR-0011 consequence).

## 9. Eval Sets (versioned fixtures, PRD F-6)

| Fixture | Contents | Size | Used by |
|---|---|---|---|
| `golden-qa.json` | `{id, question, expected_citations: [{doc_type, ata_chapter, task_no}], answer_sketch, tags}` | **≥ 50** | retrieval recall@5 / MRR (via `/api/v1/search`), grounded answer rate + citation validity (via `/api/v1/ask`) |
| `refusal-set.json` | `{id, question, expected_reason}` — questions about other (fictional) aircraft types, nonexistent procedures, fleet-current-status the corpus cannot ground | **≥ 20** | refusal accuracy (must be 100%, FR-10/20) |

Rules:
- Fixtures are committed, reviewed, and **version-bumped with corpus changes** — an eval
  run records `fixture_version`, so numbers are always traceable to the exact QA set.
- `GROUNDING_MIN_SCORE` (guardrail threshold) is calibrated once against these fixtures
  (refusal 100% + golden grounded ≥ 80%) and the calibration run is committed — thresholds
  are evidence, not vibes.
- LLM-judge metrics (faithfulness scoring) run **only** when a real provider is configured
  and are reported as a separate, clearly labeled section — CI gates never depend on them
  (offline determinism). With the mock provider, "grounded" means: answer produced with
  ≥ 1 valid citation and no refusal (PRD §7 definition).
