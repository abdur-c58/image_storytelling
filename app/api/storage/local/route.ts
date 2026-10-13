import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { env } from "@/lib/env";
import { handle, HttpError } from "@/lib/http";
import { getStorage } from "@/lib/storage";
import { LocalStorage, readLocalGrant } from "@/lib/storage/local";

function grantFor(request: Request, op: "get" | "put") {
  if (env.storageDriver !== "local") throw new HttpError(404, "Not found.");
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const grant = readLocalGrant(token);
  if (!grant || grant.op !== op) throw new HttpError(403, "Invalid or expired link.");
  return grant;
}

export const GET = handle(async (request: Request) => {
  const grant = grantFor(request, "get");
  const storage = getStorage() as LocalStorage;
  const size = await storage.head(grant.key);
  if (size === null) throw new HttpError(404, "File not found.");
  const stream = Readable.toWeb(createReadStream(storage.pathFor(grant.key))) as ReadableStream;
  const headers: Record<string, string> = {
    "content-type": grant.contentType ?? "application/octet-stream",
    "content-length": String(size),
    "cache-control": "private, no-store",
  };
  if (grant.filename) headers["content-disposition"] = `attachment; filename="${grant.filename.replace(/["\\\r\n]/g, "_")}"`;
  return new Response(stream, { headers });
});

export const PUT = handle(async (request: Request) => {
  const grant = grantFor(request, "put");
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim();
  if (grant.contentType && type !== grant.contentType) {
    throw new HttpError(415, `Content-Type must be ${grant.contentType}.`);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  await getStorage().put(grant.key, bytes, type);
  return new Response(null, { status: 200 });
});
