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
  const headers: Record<string, string> = {
    "content-type": grant.contentType ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
  };
  if (grant.filename) headers["content-disposition"] = `attachment; filename="${grant.filename.replace(/["\\\r\n]/g, "_")}"`;
  // Audio/video elements seek with Range requests (as R2 supports); without them they can't skip ahead.
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range && size > 0 && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    }
    const part = Readable.toWeb(createReadStream(storage.pathFor(grant.key), { start, end })) as ReadableStream;
    return new Response(part, {
      status: 206,
      headers: { ...headers, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` },
    });
  }
  const stream = Readable.toWeb(createReadStream(storage.pathFor(grant.key))) as ReadableStream;
  return new Response(stream, { headers: { ...headers, "content-length": String(size) } });
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
