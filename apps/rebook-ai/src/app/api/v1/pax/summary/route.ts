import { z } from "zod";

import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";

/**
 * GET /api/v1/pax/summary (rebook-ai api-contracts.md §1) — the current user's
 * disruption state. F1 contract slice: the response shape is final, the data
 * arrives with F2. `disruption: null` is the honest "no active disruption"
 * value — never a fabricated placeholder (data-ethics.md §4).
 */
const summarySchema = z.object({
  disruption: z.null(),
  offers: z.array(z.never()),
  vouchers: z.array(z.never()),
  notifications: z.array(z.never()),
});

export async function GET(): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    const session = await requireSession("passenger");
    const summary = summarySchema.parse({
      disruption: null,
      offers: [],
      vouchers: [],
      notifications: [],
    });
    return jsonResponse({ ...summary, passenger: { email: session.email, name: session.name } });
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
