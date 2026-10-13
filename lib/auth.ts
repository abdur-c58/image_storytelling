import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { newId, newToken, safeEqual, sha256Hex } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { apiTokens } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { ADMIN_COOKIE, BOT_COOKIE, botSessionTokenId, isAdminCookie } from "@/lib/session";

export * from "@/lib/session";

/** Required on cookie-authenticated bot API calls so another site cannot forge them (CSRF). */
export const BOT_CONSOLE_HEADER = "x-bot-console";

export type Role = "bot" | "worker";

export interface Principal {
  role: Role;
  tokenId: string;
  via: "bearer" | "cookie";
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
  }
}

export async function isAdmin(): Promise<boolean> {
  return isAdminCookie((await cookies()).get(ADMIN_COOKIE)?.value);
}

export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) throw new AuthError("Not signed in.", 401);
}

/** Look up a raw bearer token: bootstrap env tokens first, then hashed DB tokens. */
export async function resolveToken(raw: string): Promise<{ role: Role; tokenId: string } | null> {
  const token = raw.trim();
  if (!token) return null;
  if (env.bootstrapBotToken && safeEqual(token, env.bootstrapBotToken)) return { role: "bot", tokenId: "env:BOT_TOKEN" };
  if (env.bootstrapWorkerToken && safeEqual(token, env.bootstrapWorkerToken)) return { role: "worker", tokenId: "env:WORKER_TOKEN" };
  const db = await getDb();
  const [row] = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, sha256Hex(token)), isNull(apiTokens.revokedAt)));
  if (!row) return null;
  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id));
  return { role: row.role as Role, tokenId: row.id };
}

export async function tokenStillValid(tokenId: string): Promise<boolean> {
  if (tokenId === "env:BOT_TOKEN") return Boolean(env.bootstrapBotToken);
  if (tokenId === "env:WORKER_TOKEN") return Boolean(env.bootstrapWorkerToken);
  const db = await getDb();
  const [row] = await db.select().from(apiTokens).where(and(eq(apiTokens.id, tokenId), isNull(apiTokens.revokedAt)));
  return Boolean(row);
}

/** The bot console's cookie session, if valid. */
export async function botConsoleSession(): Promise<string | null> {
  const tokenId = botSessionTokenId((await cookies()).get(BOT_COOKIE)?.value);
  return tokenId && (await tokenStillValid(tokenId)) ? tokenId : null;
}

/** Authenticate an API request for a role. Bot routes also accept the console cookie (with the CSRF header). */
export async function authenticate(request: Request, role: Role): Promise<Principal> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) {
    const found = await resolveToken(match[1]);
    if (!found) throw new AuthError("Invalid or revoked token.", 401);
    if (found.role !== role) throw new AuthError(`This token is for the ${found.role}, not the ${role}.`, 403);
    return { ...found, via: "bearer" };
  }
  if (role === "bot") {
    const tokenId = await botConsoleSession();
    if (tokenId) {
      if (request.headers.get(BOT_CONSOLE_HEADER) !== "1") throw new AuthError(`Missing ${BOT_CONSOLE_HEADER} header.`, 403);
      return { role: "bot", tokenId, via: "cookie" };
    }
  }
  throw new AuthError("Missing bearer token.", 401);
}

export async function createApiToken(name: string, role: Role): Promise<{ id: string; token: string }> {
  const token = newToken(role);
  const id = newId("tok");
  const db = await getDb();
  await db.insert(apiTokens).values({ id, name, role, tokenHash: sha256Hex(token), prefix: token.slice(0, 12) });
  return { id, token };
}

export async function revokeApiToken(id: string): Promise<void> {
  const db = await getDb();
  await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, id));
}
