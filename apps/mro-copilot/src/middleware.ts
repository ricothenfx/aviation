import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/jwt";

/**
 * Middleware only guards routes (architecture.md §5); authorization for API
 * actions is enforced server-side in the route handlers themselves.
 */
export async function middleware(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const claims = token ? await verifySessionToken(token).catch(() => null) : null;
  const { pathname } = request.nextUrl;

  const isAppPage = pathname === "/" || APP_PAGE_PREFIXES.some((p) => pathname.startsWith(p));

  if (!claims && isAppPage) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (claims && pathname === "/login") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

const APP_PAGE_PREFIXES = ["/manuals", "/search", "/ask", "/reviews", "/engines", "/evals"];

export const config = {
  matcher: [
    "/",
    "/manuals/:path*",
    "/search/:path*",
    "/ask/:path*",
    "/reviews/:path*",
    "/engines/:path*",
    "/evals/:path*",
    "/login",
  ],
};
