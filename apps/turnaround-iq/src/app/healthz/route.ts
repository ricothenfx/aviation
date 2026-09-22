import { jsonResponse } from "@/lib/api/respond";

/** Liveness — no dependency checks (architecture.md §7). Root path per api-contracts.md §1. */
export async function GET() {
  return jsonResponse({ status: "ok" });
}
