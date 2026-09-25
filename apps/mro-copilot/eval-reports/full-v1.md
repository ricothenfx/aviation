# mro-copilot full eval — fixtures v1 (golden 52 / refusal 22)

Started: 2026-09-25T13:01:12.542Z · mock provider · public endpoints (/api/v1/search, /api/v1/ask)

| gate | value | requirement | result |
|---|---|---|---|
| recall@5 | 0.9231 | >= 0.85 | PASS |
| refusal accuracy | 1 | = 100% | PASS |
| citation validity | 1 | = 100% | PASS |
| grounded answer rate | 0.8462 | >= 80% | PASS |

Ask latency (mock, sequential): p50 89.7 ms · p95 345 ms · max 618.8 ms
Idempotent replay verified on the wire: true
Persisted eval run: cad569c4-c8f4-422f-9a9c-07bc397e4a98

All refusal cases refused with the expected machine-readable reason.
