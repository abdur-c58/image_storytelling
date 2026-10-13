import { cookies } from "next/headers";
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_SEC,
  adminSessionValue,
  BOT_COOKIE,
  BOT_SESSION_SEC,
  botSessionValue,
  checkAdminPassword,
  resolveToken,
} from "@/lib/auth";
import { clientIp, handle, rateLimit } from "@/lib/http";

const secure = process.env.NODE_ENV === "production";

/** Form POST: `password` signs into the dashboard; `bot_token` opens the bot console. */
export const POST = handle(async (request: Request) => {
  rateLimit(`login:${clientIp(request)}`, 10, 10);
  const form = await request.formData();
  const store = await cookies();
  const next = String(form.get("next") ?? "");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : null;

  const botToken = String(form.get("bot_token") ?? "");
  if (botToken) {
    const found = await resolveToken(botToken);
    if (!found || found.role !== "bot") return Response.redirect(new URL("/bot?error=1", request.url), 303);
    store.set(BOT_COOKIE, botSessionValue(found.tokenId), {
      httpOnly: true,
      secure,
      sameSite: "strict",
      maxAge: BOT_SESSION_SEC,
      path: "/",
    });
    return Response.redirect(new URL(safeNext ?? "/bot", request.url), 303);
  }

  if (!checkAdminPassword(String(form.get("password") ?? ""))) {
    return Response.redirect(new URL(`/login?error=1${safeNext ? `&next=${encodeURIComponent(safeNext)}` : ""}`, request.url), 303);
  }
  store.set(ADMIN_COOKIE, adminSessionValue(), { httpOnly: true, secure, sameSite: "lax", maxAge: ADMIN_SESSION_SEC, path: "/" });
  return Response.redirect(new URL(safeNext ?? "/projects", request.url), 303);
});
