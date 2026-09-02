/**
 * Image encoding shared by the content script and the service worker.
 *
 * Both halves need the same thing — take a Blob, get back an `ImageAttachment`
 * small enough to send — and both have `createImageBitmap` and `OffscreenCanvas`
 * available, so this is one module rather than two that drift.
 */
import type { ImageAttachment, ImageMediaType, Rect } from "./types";

/**
 * The API downsizes anything larger to fit inside this on the long edge, so
 * sending more than this is bytes and latency spent on pixels that get thrown
 * away before the model ever sees them.
 */
export const MAX_IMAGE_LONG_EDGE = 1568;

/**
 * Above this, re-encode as JPEG. Screenshots are mostly small text and JPEG
 * artifacts on small type are what makes a model misread a number, so PNG is
 * the default and JPEG is the concession made only when PNG is too big.
 */
export const PNG_FALLBACK_BYTES = 1.5 * 1024 * 1024;
export const JPEG_QUALITY = 0.9;

/** Rejected past this, after every attempt to shrink it has been made. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export const MAX_IMAGES_PER_MESSAGE = 3;

/** A drag shorter than this in either axis is a click, not a region. */
export const MIN_CAPTURE_EDGE = 8;

export const SUPPORTED_MEDIA_TYPES: readonly ImageMediaType[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/**
 * Something the user did that we can't turn into an attachment. The message is
 * written to be shown as-is — the panel renders it through its existing error
 * path rather than inventing a second error surface for images.
 */
export class ImageRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRejectedError";
  }
}

export function isSupportedMediaType(type: string): type is ImageMediaType {
  return (SUPPORTED_MEDIA_TYPES as readonly string[]).includes(type);
}

function bytesToBase64(bytes: Uint8Array): string {
  // btoa takes a string, and spreading a multi-megabyte array into
  // String.fromCharCode blows the argument limit — hence the chunking.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** Scale factor that fits `width`x`height` inside the long-edge budget. 1 if it already does. */
export function fitScale(width: number, height: number, longEdge = MAX_IMAGE_LONG_EDGE): number {
  const longest = Math.max(width, height);
  return longest > longEdge ? longEdge / longest : 1;
}

async function encode(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  type: ImageMediaType,
  quality?: number,
): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImageRejectedError("Could not read that image.");
  ctx.drawImage(bitmap, 0, 0, width, height);
  return canvas.convertToBlob({ type, quality });
}

/**
 * Decode, downscale if needed, re-encode, and package as an `ImageAttachment`.
 *
 * An image that is already small enough and already in a supported format is
 * passed through untouched — re-encoding a screenshot PNG only loses fidelity
 * and gains nothing.
 */
export async function processImage(blob: Blob): Promise<ImageAttachment> {
  if (!isSupportedMediaType(blob.type)) {
    throw new ImageRejectedError(
      `Can't attach a ${blob.type || "file of unknown type"} — images must be PNG, JPEG, WebP, or GIF.`,
    );
  }

  const bitmap = await createImageBitmap(blob);
  try {
    const scale = fitScale(bitmap.width, bitmap.height);

    let out: Blob;
    let mediaType: ImageMediaType;
    let width: number;
    let height: number;

    if (scale === 1 && blob.size <= MAX_IMAGE_BYTES) {
      out = blob;
      mediaType = blob.type;
      width = bitmap.width;
      height = bitmap.height;
    } else {
      width = Math.max(1, Math.round(bitmap.width * scale));
      height = Math.max(1, Math.round(bitmap.height * scale));
      out = await encode(bitmap, width, height, "image/png");
      mediaType = "image/png";

      if (out.size > PNG_FALLBACK_BYTES) {
        out = await encode(bitmap, width, height, "image/jpeg", JPEG_QUALITY);
        mediaType = "image/jpeg";
      }
    }

    if (out.size > MAX_IMAGE_BYTES) {
      throw new ImageRejectedError(
        `That image is ${(out.size / 1024 / 1024).toFixed(1)} MB after compression — the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
      );
    }

    return {
      id: crypto.randomUUID(),
      mediaType,
      data: await blobToBase64(out),
      width,
      height,
      byteSize: out.size,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Convert a viewport rectangle in CSS pixels into the device-pixel box to crop
 * out of a `captureVisibleTab` image.
 *
 * Handles a drag made in any direction (a right-to-left drag produces a
 * negative width) and clamps to the captured image so a drag that ran off the
 * edge of the window doesn't ask for pixels that aren't there.
 */
export function toCaptureBox(
  rect: Rect,
  devicePixelRatio: number,
  bounds?: { width: number; height: number },
): Rect {
  const left = Math.min(rect.x, rect.x + rect.width);
  const top = Math.min(rect.y, rect.y + rect.height);

  let x = Math.round(left * devicePixelRatio);
  let y = Math.round(top * devicePixelRatio);
  let width = Math.round(Math.abs(rect.width) * devicePixelRatio);
  let height = Math.round(Math.abs(rect.height) * devicePixelRatio);

  if (bounds) {
    x = Math.max(0, Math.min(x, bounds.width));
    y = Math.max(0, Math.min(y, bounds.height));
    width = Math.min(width, bounds.width - x);
    height = Math.min(height, bounds.height - y);
  }

  return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
}

/** A data: URL for an attachment, for use as an `<img src>`. */
export function toDataUrl(image: ImageAttachment): string {
  return `data:${image.mediaType};base64,${image.data}`;
}
