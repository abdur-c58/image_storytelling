import { sql } from "drizzle-orm";
import { dbDriver, getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { json } from "@/lib/http";

export async function GET() {
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    return json({ ok: true, db: await dbDriver(), storage: env.storageDriver, dry_run: env.dryRun });
  } catch (error) {
    console.error("Health check failed.", error);
    const e = error as { code?: unknown; cause?: { code?: unknown } };
    const code = e?.cause?.code ?? e?.code;
    return json({ ok: false, error: "Database unreachable.", code: typeof code === "string" ? code : undefined }, { status: 503 });
  }
}
