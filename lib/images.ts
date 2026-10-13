import "server-only";
import sharp from "sharp";

export interface ImageCheck {
  ok: boolean;
  reason: string | null;
  width: number | null;
  height: number | null;
  format: string | null;
}

export const MIN_IMAGE_WIDTH = 1280;
const TARGET_ASPECT = 16 / 9;
const ASPECT_TOLERANCE = 0.06;
const ACCEPTED_FORMATS = new Set(["png", "jpeg", "webp"]);

/** Basic QA for bot-generated images: real image, near 16:9, wide enough, not blank. */
export async function checkGeneratedImage(bytes: Uint8Array): Promise<ImageCheck> {
  let width: number | null = null;
  let height: number | null = null;
  let format: string | null = null;
  try {
    const image = sharp(bytes, { failOn: "error" });
    const meta = await image.metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
    format = meta.format ?? null;
    if (!format || !ACCEPTED_FORMATS.has(format)) {
      return { ok: false, reason: `Unsupported image format "${format ?? "unknown"}" (use PNG, JPEG or WebP).`, width, height, format };
    }
    if (!width || !height) return { ok: false, reason: "Could not read image dimensions.", width, height, format };
    if (width < MIN_IMAGE_WIDTH) {
      return { ok: false, reason: `Image is ${width}px wide; at least ${MIN_IMAGE_WIDTH}px is required.`, width, height, format };
    }
    const aspect = width / height;
    if (Math.abs(aspect - TARGET_ASPECT) / TARGET_ASPECT > ASPECT_TOLERANCE) {
      return { ok: false, reason: `Aspect ratio ${aspect.toFixed(3)} is not close to 16:9 (1.778).`, width, height, format };
    }
    const stats = await sharp(bytes).resize(256).stats();
    const maxStdev = Math.max(...stats.channels.slice(0, 3).map((c) => c.stdev));
    if (maxStdev < 4) return { ok: false, reason: "Image looks blank (almost no variation in colour).", width, height, format };
    return { ok: true, reason: null, width, height, format };
  } catch (error) {
    return { ok: false, reason: `Not a readable image: ${(error as Error).message}`, width, height, format };
  }
}

export function contentTypeForFormat(format: string | null): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}
