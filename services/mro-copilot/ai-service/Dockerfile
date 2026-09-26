# Production ai-service image for mro-copilot (ADR-0006 topology mirror, F5).
# Build from the repo root (the committed corpus lives in apps/):
#   docker build -f services/mro-copilot/ai-service/Dockerfile -t mro-ai-service .
# The committed RUL artifact ships in the image so /readyz gates `model: up`
# from the first boot (architecture.md §6); the synthetic corpus is baked in
# and ingested at startup (same code path as the CLI).
FROM python:3.12-slim
WORKDIR /srv
COPY services/mro-copilot/ai-service/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY services/mro-copilot/ai-service/mro_ai ./mro_ai
COPY services/mro-copilot/ai-service/models ./models
# Committed synthetic corpus (data-model.md §4), baked read-only.
COPY apps/mro-copilot/seed/manuals /seed/manuals
ENV MRO_CORPUS_DIR=/seed/manuals
CMD ["sh", "-c", "python -m mro_ai.ingest && uvicorn mro_ai.main:app --host 0.0.0.0 --port 4103"]
