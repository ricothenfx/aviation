import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";

/**
 * GET /api/v1/auth/me (api-contracts.md §1) — viewer+ minimum role.
 * The response is the server-side enforcement point exercised by the RBAC
 * integration matrix (DoD F1).
 */
export async function GET() {
  try {
    const session = await requireSession("viewer");
    return jsonResponse({ user: { id: session.sub, email: session.email, role: session.role } });
  } catch (err) {
    return handleRouteError(err);
  }
}
