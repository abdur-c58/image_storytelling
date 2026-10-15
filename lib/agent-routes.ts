import "server-only";
import { z } from "zod";
import {
  claimNext,
  complete,
  CompleteSchema,
  confirmBotUpload,
  directBotUpload,
  fail,
  FailSchema,
  heartbeat,
  itemStatus,
  registerUpload,
  RegisterUploadSchema,
} from "@/lib/agent-api";
import { authenticate, type Principal, type Role } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { baseUrl, handle, HttpError, json, rateLimit, readJson } from "@/lib/http";
import { hydrateTask } from "@/lib/pipeline/payloads";
import { getLeasedTask } from "@/lib/queue";

type Ctx = { params: Promise<{ id: string }> };

function agentId(request: Request, principal: Principal): string {
  const raw = request.headers.get("x-agent-id") ?? "";
  const clean = raw.replace(/[^\w.:-]/g, "").slice(0, 64);
  return clean ? `${principal.role}:${clean}` : `${principal.role}:${principal.tokenId}`;
}

async function auth(request: Request, role: Role) {
  const principal = await authenticate(request, role);
  rateLimit(`agent:${principal.tokenId}`, 240, 120);
  return { principal, agent: agentId(request, principal) };
}

const HeartbeatSchema = z.object({
  lease_id: z.string().min(1),
  progress: z
    .object({
      completed_items: z.number().int().nonnegative().optional(),
      total_items: z.number().int().nonnegative().optional(),
      message: z.string().max(500).optional(),
    })
    // The worker sends null between progress updates (a keep-alive beat during long steps).
    .nullish(),
});

const NextSchema = z.object({
  types: z.array(z.string()).optional(),
  /** Worker self-report shown on /settings: version, dry_run, which key NAMES are set (booleans only). */
  info: z.record(z.string(), z.unknown()).optional(),
});

export function agentRoutes(role: Role) {
  return {
    /** GET for the bot (?types=a,b); POST {types} for the worker. 204 when the queue is empty. */
    next: handle(async (request: Request) => {
      const { agent } = await auth(request, role);
      const body =
        request.method === "GET"
          ? { types: (new URL(request.url).searchParams.get("types") ?? "").split(",").filter(Boolean), info: undefined }
          : await readJson(request, NextSchema, 50_000);
      const task = await claimNext(role, agent, baseUrl(request), body.types, body.info);
      return task ? json(task) : new Response(null, { status: 204 });
    }),

    status: handle(async (request: Request, ctx: Ctx) => {
      await auth(request, role);
      const { id } = await ctx.params;
      const leaseId = new URL(request.url).searchParams.get("lease_id") ?? "";
      const db = await getDb();
      const task = await getLeasedTask(db, id, leaseId);
      if (!task || task.kind !== role) throw new HttpError(409, "Lease is no longer valid.", { code: "lease_lost" });
      return json({
        ...(await hydrateTask(db, task, baseUrl(request))),
        status: task.status,
        progress: task.progress,
        items_status: task.type === "generate_images" ? await itemStatus(task) : undefined,
      });
    }),

    heartbeat: handle(async (request: Request, ctx: Ctx) => {
      const { agent } = await auth(request, role);
      const { id } = await ctx.params;
      const body = await readJson(request, HeartbeatSchema);
      return json(await heartbeat(role, agent, id, body.lease_id, body.progress ?? undefined));
    }),

    uploadUrl: handle(async (request: Request, ctx: Ctx) => {
      await auth(request, role);
      const { id } = await ctx.params;
      const body = await readJson(request, RegisterUploadSchema);
      return json(await registerUpload(role, id, body, baseUrl(request)));
    }),

    complete: handle(async (request: Request, ctx: Ctx) => {
      const { agent } = await auth(request, role);
      const { id } = await ctx.params;
      const body = await readJson(request, CompleteSchema, 5_000_000);
      return json(await complete(role, agent, id, body));
    }),

    fail: handle(async (request: Request, ctx: Ctx) => {
      const { agent } = await auth(request, role);
      const { id } = await ctx.params;
      const body = await readJson(request, FailSchema);
      return json(await fail(role, agent, id, body));
    }),
  };
}

const ConfirmSchema = z.object({ lease_id: z.string().min(1), asset_id: z.string().min(1) });

/** Bot only: multipart upload (form fields lease_id, asset_key, file) or JSON confirm of a presigned upload. */
export const botAssetRoutes = {
  upload: handle(async (request: Request, ctx: Ctx) => {
    await auth(request, "bot");
    const { id } = await ctx.params;
    const type = request.headers.get("content-type") ?? "";
    if (!type.startsWith("multipart/form-data")) throw new HttpError(415, "Send multipart/form-data with lease_id, asset_key and file.");
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > 4_400_000) {
      throw new HttpError(413, "File too large for direct upload (about 4 MB limit). Use /upload-url to get a presigned URL instead.");
    }
    const form = await request.formData();
    const leaseId = String(form.get("lease_id") ?? "");
    const assetKey = String(form.get("asset_key") ?? "");
    const file = form.get("file");
    if (!leaseId || !assetKey || !(file instanceof File)) throw new HttpError(400, "lease_id, asset_key and file are required.");
    return json(await directBotUpload(id, leaseId, assetKey, file));
  }),
  confirm: handle(async (request: Request, ctx: Ctx) => {
    await auth(request, "bot");
    const { id } = await ctx.params;
    const body = await readJson(request, ConfirmSchema);
    return json(await confirmBotUpload(id, body.lease_id, body.asset_id));
  }),
};
