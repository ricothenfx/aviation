# mro-copilot full eval — fixtures v1 (golden 52 / refusal 22)

Started: 2026-09-25T20:19:21.932Z · mock provider · public endpoints (/api/v1/search, /api/v1/ask)

| gate | value | requirement | result |
|---|---|---|---|
| recall@5 | 0.9231 | >= 0.85 | PASS |
| refusal accuracy | 1 | = 100% | PASS |
| citation validity | 1 | = 100% | PASS |
| grounded answer rate | 0.8462 | >= 80% | PASS |

Ask latency (mock, sequential): p50 94.1 ms · p95 255.2 ms · max 398.8 ms
Idempotent replay verified on the wire: true
Persisted eval run: 43610708-4721-4d11-b4c7-b7612a932368

All refusal cases refused with the expected machine-readable reason.
