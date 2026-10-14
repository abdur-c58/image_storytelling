import "server-only";

function read(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function int(name: string, fallback: number): number {
  const raw = read(name);
  const value = raw ? Number(raw) : fallback;
  return Number.isFinite(value) ? value : fallback;
}

export const env = {
  get sessionSecret(): string {
    const secret = read("SESSION_SECRET");
    if (!secret && process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET is required in production.");
    return secret || "dev-only-insecure-session-secret";
  },
  get adminPassword(): string {
    return read("ADMIN_PASSWORD");
  },
  get appBaseUrl(): string {
    const url = read("APP_BASE_URL").replace(/\/$/, "");
    // A deployed site handing out localhost links breaks every bot and worker download; fall back to the request host.
    if (process.env.VERCEL && /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/i.test(url)) return "";
    return url;
  },
  get storageDriver(): "r2" | "local" {
    return read("STORAGE_DRIVER", read("R2_BUCKET_NAME") ? "r2" : "local") === "r2" ? "r2" : "local";
  },
  get storagePrefix(): string {
    const prefix = read("STORAGE_PREFIX", "slideshow-storytelling/");
    return prefix.endsWith("/") ? prefix : `${prefix}/`;
  },
  get localStorageDir(): string {
    return read("LOCAL_STORAGE_DIR", ".data/storage");
  },
  get signedUrlTtlSec(): number {
    return int("SIGNED_URL_TTL_SEC", 6 * 60 * 60);
  },
  get botLeaseSec(): number {
    return int("BOT_LEASE_SEC", 10 * 60);
  },
  get workerLeaseSec(): number {
    return int("WORKER_LEASE_SEC", 5 * 60);
  },
  get bootstrapBotToken(): string {
    return read("BOT_TOKEN");
  },
  get bootstrapWorkerToken(): string {
    return read("WORKER_TOKEN");
  },
  get cronSecret(): string {
    return read("CRON_SECRET");
  },
  get retentionDays(): number {
    return int("INTERMEDIATE_RETENTION_DAYS", 14);
  },
  get maxImageAttempts(): number {
    return int("MAX_IMAGE_ATTEMPTS", 3);
  },
  get dryRun(): boolean {
    return read("DRY_RUN") === "1";
  },
};
