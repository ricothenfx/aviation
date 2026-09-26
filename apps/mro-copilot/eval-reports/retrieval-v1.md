# mro-copilot retrieval eval — golden QA v1

Started: 2026-09-26T03:15:19.980Z · corpus corpus-manifest v1 · top-k=5 · public endpoint /api/v1/search

| metric | value | gate |
|---|---|---|
| recall@5 | 0.9231 | >= 0.85 PASS |
| hit-rate@5 | 0.9231 | informational |
| MRR | 0.8458 | informational |
| cases | 52 | >= 50 (FR-19) |

Refusal fixture v1 loaded (22 cases) — scored by the full eval from F3 (ask flow).

## Cases with missed citations (4)

- **gq-032** recall 0 — Fault code FC-2974-514 — what does it indicate and which task isolates it?
- **gq-043** recall 0 — How do I clear fault code FC-2158-874 and verify rectification?
- **gq-046** recall 0 — Where do I find the parts list for the gear actuating cylinder assembly?
- **gq-047** recall 0 — Which illustrated parts figure covers the pitch trim motor clutch?
