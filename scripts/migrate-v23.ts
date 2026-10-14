/**
 * Schema 2.3 storage move: copies files stored before story folders (projects/{id}/…, stories/{id}/master/…) to
 * stories/{story}/ep{NN}/v{V}/… and stories/{story}/masters/…, then points each asset row at its copy.
 *
 * The database part of 2.3 (episodes, versions, snapshots, the "Unsorted" story) is drizzle migration 0005,
 * applied by `npm run db:migrate` or AUTO_MIGRATE=1. This script is optional: old keys keep working.
 *
 *   node --conditions=react-server --import tsx scripts/migrate-v23.ts            # list what would move
 *   node --conditions=react-server --import tsx scripts/migrate-v23.ts --apply    # copy + update rows
 *   ... --apply --delete-old                                                      # also delete the originals
 *
 * Reads DATABASE_URL and the storage settings from the environment (.env.local is not loaded automatically).
 */
import { getDb } from "@/lib/db";
import { relocateAssets } from "@/lib/pipeline/relocate";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const deleteOld = args.has("--delete-old");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 1000;

async function main() {
  const db = await getDb();
  const report = await relocateAssets(db, { apply, deleteOld, limit });
  for (const p of report.planned.slice(0, 50)) console.log(`${p.from}\n  -> ${p.to}`);
  if (report.planned.length > 50) console.log(`… and ${report.planned.length - 50} more`);
  console.log(`${report.planned.length} object(s) ${apply ? `planned, ${report.moved} moved` : "would move (dry run; pass --apply)"}`);
  for (const f of report.failed) console.error(`failed ${f.assetId}: ${f.error}`);
  process.exit(report.failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
