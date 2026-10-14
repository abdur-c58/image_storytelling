import "server-only";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { newId } from "@/lib/crypto";
import { execRows, type Db } from "@/lib/db";
import { agents, taskEvents, tasks, type TaskRow } from "@/lib/db/schema";

export type TaskKind = "bot" | "worker";
export const WORKER_TASK_TYPES = ["voice", "voice_sample", "align", "sfx", "cards", "thumbnail_compose", "mix", "render"] as const;
export const BOT_TASK_TYPES = ["generate_images", "upload_youtube", "generate_location_master", "generate_character_group_master"] as const;
export type WorkerTaskType = (typeof WORKER_TASK_TYPES)[number];
export type BotTaskType = (typeof BOT_TASK_TYPES)[number];
export type TaskType = WorkerTaskType | BotTaskType;

export const ACTIVE_STATUSES = ["queued", "leased"] as const;
export const LIVE_STATUSES = ["queued", "leased", "done"] as const;

/** A task, event or asset belongs to an episode (project) or, for masters, to a story. */
export interface Owner {
  projectId?: string | null;
  storyId?: string | null;
}

export function ownerOf(row: { projectId: string | null; storyId: string | null }): Owner {
  return { projectId: row.projectId, storyId: row.storyId };
}

export interface NewTask extends Owner {
  kind: TaskKind;
  type: TaskType;
  scope?: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  backoffSec?: number;
  timeoutMinutes?: number;
  availableAt?: Date;
}

/** `owner` is a project id, or an Owner for story-level events. */
export async function logEvent(
  db: Db,
  owner: string | Owner,
  taskId: string | null,
  level: "info" | "warning" | "error",
  message: string,
  data?: unknown,
): Promise<void> {
  const o = typeof owner === "string" ? { projectId: owner } : owner;
  await db
    .insert(taskEvents)
    .values({ projectId: o.projectId ?? null, storyId: o.storyId ?? null, taskId, level, message, data: data ?? null });
}

export async function createTask(db: Db, input: NewTask): Promise<TaskRow> {
  if (!input.projectId === !input.storyId) throw new Error("A task belongs to exactly one project or story.");
  const [row] = await db
    .insert(tasks)
    .values({
      id: newId("tsk"),
      projectId: input.projectId ?? null,
      storyId: input.storyId ?? null,
      kind: input.kind,
      type: input.type,
      scope: input.scope ?? "all",
      status: "queued",
      payload: input.payload ?? {},
      priority: input.priority ?? 0,
      maxAttempts: input.maxAttempts ?? 3,
      backoffSec: input.backoffSec ?? 60,
      timeoutMinutes: input.timeoutMinutes ?? 60,
      availableAt: input.availableAt ?? new Date(),
    })
    .returning();
  await logEvent(db, ownerOf(row), row.id, "info", `Queued ${input.kind} task ${input.type} (${row.scope}).`);
  return row;
}

function backoffDelaySec(task: TaskRow): number {
  return task.backoffSec * Math.pow(2, Math.max(0, task.attempts - 1));
}

/**
 * Return abandoned work to the queue: leases that expired without a heartbeat, and
 * leased tasks that ran past their overall timeout. Exhausted tasks go to "dead".
 */
export async function reapExpired(db: Db): Promise<Owner[]> {
  const now = new Date();
  const expired = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, "leased"), lt(tasks.leaseExpiresAt, now)));
  const overdue = await execRows<{ id: string }>(
    db,
    sql`SELECT id FROM tasks WHERE status = 'leased' AND first_leased_at IS NOT NULL
        AND first_leased_at + (timeout_minutes * interval '1 minute') < now()`,
  );
  const overdueIds = new Set(overdue.map((r) => r.id));
  const touched = new Map<string, Owner>();
  const candidates = [...expired];
  if (overdueIds.size) {
    const extra = await db.select().from(tasks).where(inArray(tasks.id, [...overdueIds]));
    for (const t of extra) if (!candidates.some((c) => c.id === t.id)) candidates.push(t);
  }
  for (const task of candidates) {
    const reason = overdueIds.has(task.id)
      ? `Timed out after ${task.timeoutMinutes} minutes.`
      : "Lease expired without a heartbeat.";
    await requeueOrKill(db, task, reason, true);
    touched.set(`${task.projectId}|${task.storyId}`, ownerOf(task));
  }
  return [...touched.values()];
}

async function requeueOrKill(db: Db, task: TaskRow, reason: string, retryable: boolean): Promise<TaskRow> {
  const exhausted = task.attempts >= task.maxAttempts;
  const dead = !retryable || exhausted;
  const [row] = await db
    .update(tasks)
    .set({
      status: dead ? "dead" : "queued",
      error: reason,
      leaseId: null,
      leasedBy: null,
      leaseExpiresAt: null,
      firstLeasedAt: null,
      availableAt: new Date(Date.now() + (dead ? 0 : backoffDelaySec(task) * 1000)),
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, task.id))
    .returning();
  await logEvent(
    db,
    ownerOf(task),
    task.id,
    dead ? "error" : "warning",
    dead
      ? `Task ${task.type} failed permanently after ${task.attempts} attempt(s): ${reason}`
      : `Task ${task.type} will retry in ${backoffDelaySec(task)}s (attempt ${task.attempts}/${task.maxAttempts}): ${reason}`,
  );
  return row;
}

export async function leaseNext(
  db: Db,
  kind: TaskKind,
  agentId: string,
  leaseSec: number,
  types?: readonly string[],
): Promise<TaskRow | null> {
  const leaseId = newId("lease");
  const expires = new Date(Date.now() + leaseSec * 1000);
  const typeFilter = types && types.length ? sql`AND type IN (${sql.join(types.map((t) => sql`${t}`), sql`, `)})` : sql``;
  const rows = await execRows<{ id: string }>(
    db,
    sql`UPDATE tasks SET status = 'leased', lease_id = ${leaseId}, leased_by = ${agentId},
          lease_expires_at = ${expires.toISOString()}::timestamptz, attempts = attempts + 1,
          first_leased_at = coalesce(first_leased_at, now()), last_heartbeat_at = now(), updated_at = now()
        WHERE id = (
          SELECT id FROM tasks
          WHERE kind = ${kind} AND status = 'queued' AND available_at <= now() ${typeFilter}
          ORDER BY priority DESC, created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id`,
  );
  if (!rows.length) return null;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, rows[0].id));
  await logEvent(db, ownerOf(task), task.id, "info", `Leased by ${agentId} (attempt ${task.attempts}/${task.maxAttempts}).`);
  return task;
}

export async function getLeasedTask(db: Db, taskId: string, leaseId: string): Promise<TaskRow | null> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "leased"), eq(tasks.leaseId, leaseId)));
  return task ?? null;
}

export interface Progress {
  completed_items?: number;
  total_items?: number;
  message?: string;
}

export async function heartbeatTask(
  db: Db,
  taskId: string,
  leaseId: string,
  leaseSec: number,
  progress?: Progress,
): Promise<TaskRow | null> {
  const task = await getLeasedTask(db, taskId, leaseId);
  if (!task) return null;
  const [row] = await db
    .update(tasks)
    .set({
      leaseExpiresAt: new Date(Date.now() + leaseSec * 1000),
      lastHeartbeatAt: new Date(),
      progress: progress ? { ...(task.progress as object), ...progress } : task.progress,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))
    .returning();
  if (progress?.message) await logEvent(db, ownerOf(task), taskId, "info", progress.message);
  return row;
}

export async function completeTask(db: Db, taskId: string, leaseId: string, result: unknown): Promise<TaskRow | null> {
  const task = await getLeasedTask(db, taskId, leaseId);
  if (!task) return null;
  const [row] = await db
    .update(tasks)
    .set({
      status: "done",
      result: (result ?? {}) as object,
      error: null,
      leaseId: null,
      leaseExpiresAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))
    .returning();
  const r = (result ?? {}) as { missing?: unknown; notes?: unknown };
  const missing = Array.isArray(r.missing) ? r.missing.filter((m): m is string => typeof m === "string") : [];
  const notes = typeof r.notes === "string" ? r.notes.trim().slice(0, 1000) : "";
  const summary = [missing.length ? `${missing.length} not delivered (${missing.join(", ")}); they will be requested again.` : "", notes ? `Bot notes: ${notes}` : ""]
    .filter(Boolean)
    .join(" ");
  await logEvent(db, ownerOf(task), taskId, missing.length ? "warning" : "info", `Task ${task.type} completed.${summary ? ` ${summary}` : ""}`);
  return row;
}

export async function failTask(
  db: Db,
  taskId: string,
  leaseId: string,
  reason: string,
  retryable: boolean,
): Promise<TaskRow | null> {
  const task = await getLeasedTask(db, taskId, leaseId);
  if (!task) return null;
  return requeueOrKill(db, task, reason.slice(0, 4000), retryable);
}

/** Put a dead/failed task back in the queue with a fresh attempt budget. */
export async function retryTask(db: Db, taskId: string): Promise<void> {
  await db
    .update(tasks)
    .set({ status: "queued", attempts: 0, error: null, availableAt: new Date(), firstLeasedAt: null, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, ["dead", "cancelled"])));
}

export async function touchAgent(db: Db, agentId: string, role: TaskKind, info?: Record<string, unknown>): Promise<void> {
  await db
    .insert(agents)
    .values({ agentId, role, lastSeenAt: new Date(), info: info ?? {} })
    .onConflictDoUpdate({ target: agents.agentId, set: info ? { lastSeenAt: new Date(), info } : { lastSeenAt: new Date() } });
}

export async function recentTasks(db: Db, projectId: string): Promise<TaskRow[]> {
  return db.select().from(tasks).where(eq(tasks.projectId, projectId)).orderBy(desc(tasks.createdAt));
}
