# mro-copilot full eval — fixtures v1 (golden 52 / refusal 22)

Started: 2026-09-25T19:14:11.848Z · mock provider · public endpoints (/api/v1/search, /api/v1/ask)

| gate | value | requirement | result |
|---|---|---|---|
| recall@5 | 0.9231 | >= 0.85 | PASS |
| refusal accuracy | 1 | = 100% | PASS |
| citation validity | 1 | = 100% | PASS |
| grounded answer rate | 0.8462 | >= 80% | PASS |

Ask latency (mock, sequential): p50 125.4 ms · p95 481.8 ms · max 659.9 ms
Idempotent replay verified on the wire: true
Persisted eval run: 8b3e3c7f-8cf9-485e-9ee9-c8f22d16bd08

All refusal cases refused with the expected machine-readable reason.
