import { loginRequestSchema } from "@aviation/contracts";
import type { NextRequest } from "next/server";

import { handleRouteError, jsonResponse } from "@/lib/api/respond";
import { signSessionToken } from "@/lib/auth/jwt";
import { createLocalAuthProvider } from "@/lib/auth/local-provider";
import { setSessionCookie } from "@/lib/auth/session";
import { logger } from "@/lib/logger";

/**
 * POST /api/v1/auth/login (api-contracts.md §1).
 * Body {email, password} → {user, token} + httpOnly session cookie (D-09).
 */
export async function POST(request: NextRequest) {
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
    logger.info({ msg: "login_succeeded", role: user.role });
    return jsonResponse({
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
      token,
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
