import { desc, gt, sql } from "drizzle-orm";
import { dbDriver, getDb } from "@/lib/db";
import { agents, apiTokens, usageEvents } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { ago, PageHeader } from "../ui";
import { listChannelCharacters } from "@/lib/pipeline/cast";
import { getVoiceSettings } from "@/lib/pipeline/voices";
import { TokenManager } from "./tokens";
import { VoiceSettingsForm } from "./voices";

/** Names only. Values are never read into the page. */
const SITE_KEYS = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "ADMIN_PASSWORD",
  "APP_BASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "CRON_SECRET",
  "BOT_TOKEN",
  "WORKER_TOKEN",
];

function KeyFlag({ name, set }: { name: string; set: boolean }) {
  return (
    <span className={`flex items-center gap-2 font-mono text-xs ${set ? "" : "text-muted"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${set ? "bg-ok" : "border border-line-hover"}`} />
      {name}
    </span>
  );
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 3600 * 1000);
}

function isStale(lastSeen: Date): boolean {
  return Date.now() - new Date(lastSeen).getTime() > 5 * 60_000;
}

export default async function SettingsPage() {
  const db = await getDb();
  const since = daysAgo(30);
  const [tokens, agentRows, usage, driver, voiceSettings, channelCast] = await Promise.all([
    db.select().from(apiTokens).orderBy(desc(apiTokens.createdAt)),
    db.select().from(agents).orderBy(desc(agents.lastSeenAt)),
    db
      .select({
        provider: usageEvents.provider,
        unit: usageEvents.unit,
        total: sql<number>`sum(${usageEvents.quantity})`,
      })
      .from(usageEvents)
      .where(gt(usageEvents.createdAt, since))
      .groupBy(usageEvents.provider, usageEvents.unit),
    dbDriver(),
    getVoiceSettings(db),
    listChannelCharacters(db),
  ]);
  return (
    <>
      <PageHeader eyebrow="System" title="Settings" />
      <div className="flex flex-col gap-6">
        <section className="grid gap-6 lg:grid-cols-2">
          <div className="card flex flex-col gap-4 text-sm">
            <h2 className="eyebrow">Site</h2>
            <dl className="grid grid-cols-2 gap-y-1.5">
              <dt className="font-light text-muted">Database</dt>
              <dd>{driver}</dd>
              <dt className="font-light text-muted">Storage</dt>
              <dd>
                {env.storageDriver} · <code className="text-xs">{env.storagePrefix}</code>
              </dd>
              <dt className="font-light text-muted">Dry run</dt>
              <dd>{env.dryRun ? "on" : "off"}</dd>
              <dt className="font-light text-muted">Signed URL lifetime</dt>
              <dd>{Math.round(env.signedUrlTtlSec / 3600)} h</dd>
            </dl>
            <h3 className="eyebrow mt-2">Environment</h3>
            <div className="grid grid-cols-2 gap-1.5">
              {SITE_KEYS.map((k) => (
                <KeyFlag key={k} name={k} set={Boolean(process.env[k])} />
              ))}
            </div>
          </div>
          <div className="card flex flex-col gap-4 text-sm">
            <h2 className="eyebrow">Worker &amp; bot</h2>
            {agentRows.length === 0 && <p className="font-light text-muted">Nothing has connected yet.</p>}
            {agentRows.map((a) => {
              const info = a.info as { version?: string; dry_run?: boolean; keys?: Record<string, boolean>; gpu?: string };
              const stale = isStale(a.lastSeenAt);
              return (
                <div key={a.agentId} className="flex flex-col gap-2 border-t border-line pt-3 first-of-type:border-0 first-of-type:pt-0">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{a.agentId}</span>
                    <span className={`chip ${stale ? "text-warn" : "text-ok"}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${stale ? "bg-warn" : "bg-ok"}`} />
                      {ago(a.lastSeenAt)}
                    </span>
                  </div>
                  {info.version && (
                    <div className="text-xs font-light text-muted">
                      v{info.version} {info.gpu ? `· ${info.gpu}` : ""} {info.dry_run ? "· dry run" : ""}
                    </div>
                  )}
                  {info.keys && (
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {Object.entries(info.keys).map(([k, set]) => (
                        <KeyFlag key={k} name={k} set={set} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
        <VoiceSettingsForm
          defaultVoiceId={voiceSettings.default_voice_id}
          channelVoices={voiceSettings.channel}
          cast={channelCast.map((c) => {
            const voice = (c.definition as { voice?: { voice_id?: string } | null }).voice;
            return { id: c.id, name: c.name, jsonVoiceId: voice?.voice_id ?? "", canSpeak: !!voice };
          })}
        />
        <TokenManager
          tokens={tokens.map((t) => ({
            id: t.id,
            name: t.name,
            role: t.role,
            prefix: t.prefix,
            lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
            revokedAt: t.revokedAt?.toISOString() ?? null,
            createdAt: t.createdAt.toISOString(),
          }))}
        />
        <section className="card text-sm">
          <h2 className="eyebrow mb-3">Usage · last 30 days</h2>
          {usage.length === 0 && <p className="font-light text-muted">No usage recorded.</p>}
          <dl className="grid grid-cols-3 gap-y-1.5">
            {usage.map((u) => (
              <div key={`${u.provider}-${u.unit}`} className="contents">
                <dt>{u.provider}</dt>
                <dd className="font-light text-muted">{u.unit}</dd>
                <dd className="text-right tabular-nums">{Math.round(Number(u.total)).toLocaleString()}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </>
  );
}
