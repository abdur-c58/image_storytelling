import { cookies } from "next/headers";
import { ADMIN_COOKIE, BOT_COOKIE } from "@/lib/auth";

export async function POST(request: Request) {
  const store = await cookies();
  store.delete(ADMIN_COOKIE);
  store.delete(BOT_COOKIE);
  return Response.redirect(new URL("/login", request.url), 303);
}
