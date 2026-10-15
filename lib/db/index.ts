import "server-only";
import path from "node:path";
import { mkdirSync } from "node:fs";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

interface DbHandle {
  db: Db;
  driver: "postgres" | "pglite";
  ready: Promise<void>;
}

const globalForDb = globalThis as unknown as { __slideshowDb?: DbHandle };

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

function databaseUrl(): string {
  return (process.env.DATABASE_URL ?? "").trim();
}

async function createHandle(): Promise<Omit<DbHandle, "ready"> & { migrate: () => Promise<void>; close: () => Promise<void> }> {
  const url = databaseUrl();
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    // Supabase's transaction pooler (port 6543) does not support prepared statements.
    const client = postgres(url, { prepare: false, max: Number(process.env.DATABASE_POOL_MAX ?? 5) });
    const db = drizzle(client, { schema }) as unknown as Db;
    return {
      db,
      driver: "postgres",
      migrate: async () => {
        // Never migrate from `next build`: a build must not change the database it happens to point at.
        if (process.env.AUTO_MIGRATE === "1" && process.env.NEXT_PHASE !== "phase-production-build") {
          await migrate(db as never, { migrationsFolder: MIGRATIONS_DIR });
        }
      },
      close: () => client.end({ timeout: 5 }),
    };
  }
  const dataDir = url.startsWith("pglite:") ? url.slice("pglite:".length) : path.join(process.cwd(), ".data", "pglite");
  if (!dataDir.startsWith("memory://")) mkdirSync(dataDir, { recursive: true });
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, driver: "pglite", migrate: () => migrate(db as never, { migrationsFolder: MIGRATIONS_DIR }), close: () => client.close() };
}

let pending: Promise<DbHandle> | null = null;

async function handle(): Promise<DbHandle> {
  if (globalForDb.__slideshowDb) return globalForDb.__slideshowDb;
  pending ??= (async () => {
    const created = await createHandle();
    const h: DbHandle = { db: created.db, driver: created.driver, ready: Promise.resolve() };
    // A failed start-up (pooler hiccup, two instances migrating at once) must not poison this
    // instance for its whole lifetime: forget the handle so the next request starts over.
    h.ready = created.migrate().catch((error) => {
      console.error("Database start-up failed; will retry on the next request.", error);
      if (globalForDb.__slideshowDb === h) globalForDb.__slideshowDb = undefined;
      pending = null;
      void created.close().catch(() => {});
      throw error;
    });
    globalForDb.__slideshowDb = h;
    return h;
  })().catch((error) => {
    pending = null;
    throw error;
  });
  return pending;
}

export async function getDb(): Promise<Db> {
  const h = await handle();
  await h.ready;
  return h.db;
}

export async function dbDriver(): Promise<string> {
  return (await handle()).driver;
}

/** postgres-js returns an array, PGlite returns { rows }; normalise both. */
export async function execRows<T = Record<string, unknown>>(db: Db, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown;
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export { schema };
