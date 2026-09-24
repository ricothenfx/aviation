import { clearSessionCookie } from "@/lib/auth/session";

/** POST /api/v1/auth/logout (api-contracts.md §1) → 204. */
export async function POST() {
  await clearSessionCookie();
  return new Response(null, { status: 204 });
}
