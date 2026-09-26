import { clearSessionCookie } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/api/respond";

/** POST /api/v1/auth/logout — clears the session cookie (api-contracts.md §1). */
export async function POST(): Promise<Response> {
  await clearSessionCookie();
  return jsonResponse({ ok: true });
}
