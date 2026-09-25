# mro-copilot full eval — fixtures v1 (golden 52 / refusal 22)

Started: 2026-09-25T13:37:13.941Z · mock provider · public endpoints (/api/v1/search, /api/v1/ask)

| gate | value | requirement | result |
|---|---|---|---|
| recall@5 | 0.9231 | >= 0.85 | PASS |
| refusal accuracy | 1 | = 100% | PASS |
| citation validity | 1 | = 100% | PASS |
| grounded answer rate | 0.8462 | >= 80% | PASS |

Ask latency (mock, sequential): p50 125.6 ms · p95 351.2 ms · max 400.6 ms
Idempotent replay verified on the wire: true
Persisted eval run: c685d335-cc2d-4e6a-9930-4bde882d9eca

All refusal cases refused with the expected machine-readable reason.
