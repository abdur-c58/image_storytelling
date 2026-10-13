import "server-only";
import { headers } from "next/headers";
import { ZodError, type z } from "zod";
import { AuthError } from "@/lib/auth";
import { env } from "@/lib/env";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, { ...init, headers: { "cache-control": "no-store", ...init.headers } });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: error.message, ...error.extra }, { status: error.status });
  if (error instanceof AuthError) return json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) {
    return json(
      { error: "Invalid request body.", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      { status: 400 },
    );
  }
  console.error(error);
  return json({ error: "Internal error." }, { status: 500 });
}

/** Wrap a route handler so thrown HttpError/AuthError/ZodError become JSON responses. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export async function readJson<T extends z.ZodType>(request: Request, schema: T, maxBytes = 1_000_000): Promise<z.infer<T>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new HttpError(413, `Body larger than ${maxBytes} bytes.`);
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, `Body larger than ${maxBytes} bytes.`);
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(400, "Body is not valid JSON.");
    }
  }
  return schema.parse(raw);
}

/** Public base URL for links handed to the bot and worker. */
export function baseUrl(request: Request): string {
  if (env.appBaseUrl) return env.appBaseUrl;
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** Same as baseUrl() but for server components, which only have headers(). */
export async function pageBaseUrl(): Promise<string> {
  if (env.appBaseUrl) return env.appBaseUrl;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export function clientIp(request: Request): string {
  return (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || request.headers.get("x-real-ip") || "local";
}

const buckets = new Map<string, { tokens: number; updated: number }>();

/**
 * Token bucket per key, in memory. On Vercel each instance has its own buckets, so this caps
 * bursts per instance rather than globally; good enough for brute-force and runaway-loop protection.
 */
export function rateLimit(key: string, perMinute: number, burst = perMinute): void {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: burst, updated: now };
  bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.updated) / 60_000) * perMinute);
  bucket.updated = now;
  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    const retry = Math.ceil(((1 - bucket.tokens) / perMinute) * 60);
    throw new HttpError(429, "Too many requests.", { retry_after_sec: retry });
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) if (now - b.updated > 10 * 60_000) buckets.delete(k);
  }
}
