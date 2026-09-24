"""Bearer-token dependency guarding /internal/v1 (ADR-0012 §5).

The ai-service is internal-only: requests must carry the shared secret as
`Authorization: Bearer <AI_SERVICE_TOKEN>`. A missing token at boot is a loud
configuration error — the service refuses to serve internal routes.
"""

from __future__ import annotations

import hmac

from fastapi import HTTPException, Request, status

from mro_ai.config import Config


def require_service_token(request: Request) -> None:
    config: Config = request.app.state.config
    expected = config.ai_service_token
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI_SERVICE_TOKEN is not configured; internal routes are disabled",
        )
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(token, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid service token",
            headers={"WWW-Authenticate": "Bearer"},
        )
