import { loginRequestSchema } from "@aviation/contracts";

import { createLocalAuthProvider } from "@/lib/auth/local-provider";
import { SESSION_TTL_SECONDS, signSessionToken } from "@/lib/auth/jwt";
import { setSessionCookie } from "@/lib/auth/session";
import { handleRouteError, jsonResponse } from "@/lib/api/respond";
import { logger } from "@/lib/logger";

/**
 * POST /api/v1/auth/login (rebook-ai api-contracts.md §1). Seeded users only
 * (D-09); errors use the standard envelope (401 UNAUTHENTICATED).
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    const body = loginRequestSchema.parse(await request.json());
    const provider = createLocalAuthProvider();
    const user = await provider.signIn(body.email, body.password);
    const token = await signSessionToken({
      sub: user.id,
      email: user.email,
      name: user.displayName,
      role: user.role,
    });
    await setSessionCookie(token);
    logger.info({ msg: "login", requestId, userId: user.id, role: user.role });
    return jsonResponse({ user, sessionExpiresIn: SESSION_TTL_SECONDS }, 200);
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
