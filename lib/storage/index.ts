import "server-only";
import { env } from "@/lib/env";
import { LocalStorage } from "./local";
import { R2Storage } from "./r2";

export interface PresignOptions {
  /** Absolute origin of this site, used by drivers that serve files through our own routes. */
  baseUrl: string;
  ttlSec?: number;
  contentType?: string;
  downloadFilename?: string;
}

export interface Storage {
  readonly driver: "r2" | "local";
  presignPut(key: string, options: PresignOptions): Promise<string>;
  presignGet(key: string, options: PresignOptions): Promise<string>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Size in bytes, or null when the object does not exist. */
  head(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
  /** Deletes every object whose key starts with `prefix`; returns how many were removed. */
  deletePrefix(prefix: string): Promise<number>;
}

const globalForStorage = globalThis as unknown as { __slideshowStorage?: Storage };

export function getStorage(): Storage {
  if (!globalForStorage.__slideshowStorage) {
    globalForStorage.__slideshowStorage = env.storageDriver === "r2" ? new R2Storage() : new LocalStorage();
  }
  return globalForStorage.__slideshowStorage;
}

/** All objects for this app live under STORAGE_PREFIX, separate from the Billions folders in the same bucket. */
export function projectObjectKey(projectId: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._/-]/g, "_").replace(/\.\.+/g, ".");
  return `${env.storagePrefix}projects/${projectId}/${safe}`;
}

/** Folder holding every object of one project. Refuses ids that could widen the prefix. */
export function projectObjectPrefix(projectId: string): string {
  if (!/^prj_[A-Za-z0-9_-]+$/.test(projectId)) throw new Error("Invalid project id.");
  return `${env.storagePrefix}projects/${projectId}/`;
}
