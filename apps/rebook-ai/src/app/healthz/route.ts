import { jsonResponse } from "@/lib/api/respond";

/** Liveness — no dependency checks (rebook-ai architecture.md §7). */
export async function GET() {
  return jsonResponse({ status: "ok" });
}
