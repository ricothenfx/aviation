# mro-copilot full eval — fixtures v1 (golden 52 / refusal 22)

Started: 2026-09-26T03:15:30.690Z · mock provider · public endpoints (/api/v1/search, /api/v1/ask)

| gate | value | requirement | result |
|---|---|---|---|
| recall@5 | 0.9231 | >= 0.85 | PASS |
| refusal accuracy | 1 | = 100% | PASS |
| citation validity | 1 | = 100% | PASS |
| grounded answer rate | 0.8462 | >= 80% | PASS |

Ask latency (mock, sequential): p50 157.4 ms · p95 713.6 ms · max 1493.7 ms
Idempotent replay verified on the wire: true
Persisted eval run: 93274f4c-95a6-4fad-b0f8-f6c2d0253e50

All refusal cases refused with the expected machine-readable reason.
