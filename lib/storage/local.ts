import "server-only";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { signToken, verifyToken } from "@/lib/crypto";
import { env } from "@/lib/env";
import type { PresignOptions, Storage } from "./index";

export interface LocalGrant {
  key: string;
  op: "get" | "put";
  contentType?: string;
  filename?: string;
}

/** Dev driver: files on disk, served by /api/storage/local with HMAC-signed, expiring URLs. */
export class LocalStorage implements Storage {
  readonly driver = "local" as const;
  private root = path.resolve(/* turbopackIgnore: true */ process.cwd(), env.localStorageDir);

  pathFor(key: string): string {
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(this.root + path.sep)) throw new Error("Invalid storage key.");
    return resolved;
  }

  private url(grant: LocalGrant, options: PresignOptions): string {
    const token = signToken(env.sessionSecret, JSON.stringify(grant), options.ttlSec ?? env.signedUrlTtlSec);
    return `${options.baseUrl}/api/storage/local?t=${encodeURIComponent(token)}`;
  }

  async presignPut(key: string, options: PresignOptions): Promise<string> {
    return this.url({ key, op: "put", contentType: options.contentType }, options);
  }

  async presignGet(key: string, options: PresignOptions): Promise<string> {
    return this.url({ key, op: "get", contentType: options.contentType, filename: options.downloadFilename }, options);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async copy(fromKey: string, toKey: string): Promise<void> {
    const target = this.pathFor(toKey);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(this.pathFor(fromKey), target);
  }

  async head(key: string): Promise<number | null> {
    try {
      return (await stat(this.pathFor(key))).size;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix.endsWith("/") || prefix === env.storagePrefix) throw new Error("Refusing to delete outside a project folder.");
    const dir = this.pathFor(prefix.slice(0, -1));
    const count = await readdir(dir, { recursive: true, withFileTypes: true })
      .then((entries) => entries.filter((e) => e.isFile()).length)
      .catch(() => 0);
    await rm(dir, { recursive: true, force: true });
    return count;
  }
}

export function readLocalGrant(token: string): LocalGrant | null {
  const payload = verifyToken(env.sessionSecret, token);
  if (!payload) return null;
  try {
    return JSON.parse(payload) as LocalGrant;
  } catch {
    return null;
  }
}
