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

const safeName = (name: string) => name.replace(/[^a-zA-Z0-9._/-]/g, "_").replace(/\.\.+/g, ".");

/** Pre-2.3 layout: projects/{id}/… (still read; new files go under stories/). */
export function projectObjectKey(projectId: string, name: string): string {
  return `${env.storagePrefix}projects/${projectId}/${safeName(name)}`;
}

/** Story-level files: masters/… for location plates and character sheets, otherwise by asset key. */
export function storyObjectKey(storyId: string, name: string): string {
  const safe = safeName(name);
  return `${storyObjectPrefix(storyId)}${safe.startsWith("master/") ? `masters/${safe.slice("master/".length)}` : safe}`;
}

/** All of one episode version's files (schema 2.3): stories/{story}/ep{NN}/v{V}/. */
export function episodeObjectPrefix(storyId: string, episodeNumber: number, version: number): string {
  if (!Number.isInteger(episodeNumber) || episodeNumber < 1 || !Number.isInteger(version) || version < 1) {
    throw new Error("Invalid episode number or version.");
  }
  return `${storyObjectPrefix(storyId)}ep${String(episodeNumber).padStart(2, "0")}/v${version}/`;
}

export function episodeObjectKey(storyId: string, episodeNumber: number, version: number, name: string): string {
  return `${episodeObjectPrefix(storyId, episodeNumber, version)}${safeName(name)}`;
}

export function storyObjectPrefix(storyId: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(storyId)) throw new Error("Invalid story id.");
  return `${env.storagePrefix}stories/${storyId}/`;
}

/** Folder holding every object of one project. Refuses ids that could widen the prefix. */
export function projectObjectPrefix(projectId: string): string {
  if (!/^prj_[A-Za-z0-9_-]+$/.test(projectId)) throw new Error("Invalid project id.");
  return `${env.storagePrefix}projects/${projectId}/`;
}
