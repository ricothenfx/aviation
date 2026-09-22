import type { NextRequest } from "next/server";

import { wsTokenResponseSchema } from "@aviation/contracts";

import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { signWsToken } from "@/lib/auth/jwt";

export const dynamic = "force-dynamic";

const GATEWAY_WS_PATH = "/api/ws";

/**
 * POST /api/v1/auth/ws-token — mints the short-lived signed token for the ws
 * upgrade (architecture.md §5: "short-lived signed token query param at upgrade").
 * Any authenticated role may connect; RBAC for reads is viewer+ anyway.
 */
export async function POST(_request: NextRequest) {
  try {
    const session = await requireSession("viewer");
    const token = await signWsToken(session);
    const url = process.env.NEXT_PUBLIC_WS_URL ?? defaultWsUrl();
    return jsonResponse(wsTokenResponseSchema.parse({ token, url }));
  } catch (err) {
    return handleRouteError(err);
  }
}

function defaultWsUrl(): string {
  const port = process.env.GATEWAY_PUBLIC_PORT ?? "4001";
  return `ws://localhost:${port}${GATEWAY_WS_PATH}`;
}
