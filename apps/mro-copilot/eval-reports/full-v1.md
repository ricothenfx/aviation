# mro-copilot full eval — fixtures v1 (golden 52 / refusal 22)

Started: 2026-09-29T20:12:01.660Z · mock provider · public endpoints (/api/v1/search, /api/v1/ask)

| gate | value | requirement | result |
|---|---|---|---|
| recall@5 | 0.9231 | >= 0.85 | PASS |
| refusal accuracy | 1 | = 100% | PASS |
| citation validity | 1 | = 100% | PASS |
| grounded answer rate | 0.8462 | >= 80% | PASS |

Ask latency (mock, sequential): p50 136 ms · p95 384.3 ms · max 619.6 ms
Idempotent replay verified on the wire: true
Persisted eval run: 387f8701-0035-4d10-945d-75632f2dabfb

All refusal cases refused with the expected machine-readable reason.
