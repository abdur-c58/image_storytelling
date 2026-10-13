import { safeEqual, sha256Hex, signToken, verifyToken } from "@/lib/crypto";
import { env } from "@/lib/env";

export const ADMIN_COOKIE = "ss_admin";
export const BOT_COOKIE = "ss_bot";
export const ADMIN_SESSION_SEC = 7 * 24 * 3600;
export const BOT_SESSION_SEC = 12 * 3600;

export function adminConfigured(): boolean {
  return env.adminPassword.length > 0;
}

export function checkAdminPassword(password: string): boolean {
  return adminConfigured() && safeEqual(sha256Hex(password), sha256Hex(env.adminPassword));
}

export function adminSessionValue(): string {
  return signToken(env.sessionSecret, "admin", ADMIN_SESSION_SEC);
}

/** Without ADMIN_PASSWORD the dashboard is open in development only. */
export function isAdminCookie(value: string | undefined): boolean {
  if (!adminConfigured()) return process.env.NODE_ENV !== "production";
  return Boolean(value) && verifyToken(env.sessionSecret, value!) === "admin";
}

export function botSessionValue(tokenId: string): string {
  return signToken(env.sessionSecret, `bot:${tokenId}`, BOT_SESSION_SEC);
}

export function botSessionTokenId(value: string | undefined): string | null {
  const payload = value ? verifyToken(env.sessionSecret, value) : null;
  return payload?.startsWith("bot:") ? payload.slice(4) : null;
}
