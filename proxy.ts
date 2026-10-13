import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, isAdminCookie } from "@/lib/session";

/** Optimistic gate for dashboard pages; every page and server action re-checks with requireAdmin(). */
export function proxy(request: NextRequest) {
  if (isAdminCookie(request.cookies.get(ADMIN_COOKIE)?.value)) return NextResponse.next();
  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!api/|login|bot|_next/|favicon.ico|.*\\.(?:png|jpg|svg|ico|css|js)$).*)"],
};
