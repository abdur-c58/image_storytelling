import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

export function newToken(role: "bot" | "worker"): string {
  return `${role}_${randomBytes(24).toString("base64url")}`;
}

export function sha256Hex(input: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** `payload.expiry.signature`, all base64url. */
export function signToken(secret: string, payload: string, ttlSec: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = `${Buffer.from(payload).toString("base64url")}.${exp}`;
  return `${body}.${hmac(secret, body)}`;
}

export function verifyToken(secret: string, token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [payload, expRaw, signature] = parts;
  const body = `${payload}.${expRaw}`;
  if (!safeEqual(hmac(secret, body), signature)) return null;
  if (Number(expRaw) < Math.floor(Date.now() / 1000)) return null;
  return Buffer.from(payload, "base64url").toString("utf8");
}
