/** Episode status roll-up for story folders (schema 2.3). Safe for client components. */

export const STATUS_BUCKETS = ["draft", "in_progress", "awaiting_bot", "ready", "published", "failed"] as const;
export type StatusBucket = (typeof STATUS_BUCKETS)[number];

export const BUCKET_LABEL: Record<StatusBucket, string> = {
  draft: "Draft",
  in_progress: "In progress",
  awaiting_bot: "Awaiting bot",
  ready: "Ready",
  published: "Published",
  failed: "Failed",
};

export const BUCKET_DOT: Record<StatusBucket, string> = {
  draft: "bg-muted",
  in_progress: "bg-info",
  awaiting_bot: "bg-warn",
  ready: "bg-warn",
  published: "bg-ok",
  failed: "bg-bad",
};

/** `botBusy`: the version has a queued or running bot task (images, masters, upload). */
export function statusBucket(state: string, botBusy: boolean): StatusBucket {
  if (state === "PUBLISHED") return "published";
  if (state === "FAILED") return "failed";
  if (state === "DRAFT") return "draft";
  if (state === "REVIEW") return "ready";
  if (botBusy || state === "PUBLISH_REQUESTED" || state === "WAITING_MASTERS") return "awaiting_bot";
  return "in_progress";
}
