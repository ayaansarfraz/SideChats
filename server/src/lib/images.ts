import type { ImageMediaType, StoredImage } from "../types.js";

/**
 * Server-side limits. The extension enforces the same numbers at capture time
 * (`extension/src/shared/image.ts`), but a client-side cap is a UX affordance,
 * not a limit — these are the ones that actually hold.
 */
export const MAX_IMAGES_PER_MESSAGE = 3;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_REQUEST_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * `express.json()`'s limit. 5 MB of decoded image data is ~6.7 MB base64, plus
 * the JSON around it; the 100 KB default 413s every screenshot before a route
 * ever sees it. Lives here so `index.ts` and the route tests can't drift.
 */
export const JSON_BODY_LIMIT = "12mb";

export const ALLOWED_MEDIA_TYPES: readonly ImageMediaType[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/** Bare base64 — a `data:` URL prefix fails here on purpose, the API wants raw. */
const BASE64_CHARSET = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decoded length from the encoded length, without allocating the buffer. A
 * client-reported `byteSize` is not a limit, so the size is re-derived from the
 * bytes that actually arrived.
 */
export function decodedByteSize(data: string): number {
  if (data.length === 0) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

function mb(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return `${Number.isInteger(value) ? value : value.toFixed(1)} MB`;
}

type ImageResult = { image: StoredImage | null; bytes: number; errors: string[] };

/**
 * Validates one image and returns a `StoredImage` built field by field, so
 * anything extra the client sent (`byteSize`, or whatever a future version
 * adds) is dropped rather than stored and echoed back to the API.
 */
function validateImage(value: unknown, field: string): ImageResult {
  const errors: string[] = [];

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { image: null, bytes: 0, errors: [`${field} (must be an object)`] };
  }

  const { id, mediaType, data, width, height } = value as Record<string, unknown>;

  if (typeof id !== "string" || id.length === 0) {
    errors.push(`${field}.id (must be a non-empty string)`);
  }
  if (typeof mediaType !== "string" || !ALLOWED_MEDIA_TYPES.includes(mediaType as ImageMediaType)) {
    errors.push(`${field}.mediaType (must be one of ${ALLOWED_MEDIA_TYPES.join(", ")})`);
  }
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
    errors.push(`${field}.width (must be a positive number)`);
  }
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) {
    errors.push(`${field}.height (must be a positive number)`);
  }

  let bytes = 0;
  if (typeof data !== "string" || data.length === 0) {
    errors.push(`${field}.data (must be a non-empty base64 string)`);
  } else if (data.length % 4 !== 0 || !BASE64_CHARSET.test(data)) {
    errors.push(`${field}.data (not valid base64 — send bare base64, no "data:" prefix)`);
  } else {
    bytes = decodedByteSize(data);
    if (bytes > MAX_IMAGE_BYTES) {
      errors.push(
        `${field}.data (${bytes} bytes decoded, over the ${mb(MAX_IMAGE_BYTES)} per-image limit)`,
      );
    }
  }

  if (errors.length > 0) return { image: null, bytes, errors };

  return {
    image: {
      id: id as string,
      mediaType: mediaType as ImageMediaType,
      data: data as string,
      width: width as number,
      height: height as number,
    },
    bytes,
    errors,
  };
}

export type ImageFields = {
  images: StoredImage[];
  screenshot?: StoredImage;
  /**
   * Field-named failures, same idiom as the route's `missing: string[]` — a
   * blanket "bad images" tells you nothing about which of three attachments
   * the client mis-encoded.
   */
  errors: string[];
};

/**
 * Validates the `images` array and the optional `screenshot` on a request body.
 * Absent fields are valid: no image is the overwhelmingly common case and the
 * text-only path must stay untouched.
 */
export function validateImageFields(raw: { images?: unknown; screenshot?: unknown }): ImageFields {
  const errors: string[] = [];
  const images: StoredImage[] = [];
  let screenshot: StoredImage | undefined;
  let totalBytes = 0;

  if (raw.screenshot !== undefined && raw.screenshot !== null) {
    const result = validateImage(raw.screenshot, "screenshot");
    errors.push(...result.errors);
    totalBytes += result.bytes;
    if (result.image) screenshot = result.image;
  }

  if (raw.images !== undefined && raw.images !== null) {
    if (!Array.isArray(raw.images)) {
      errors.push("images (must be an array)");
    } else if (raw.images.length > MAX_IMAGES_PER_MESSAGE) {
      errors.push(
        `images (${raw.images.length} images, at most ${MAX_IMAGES_PER_MESSAGE} per message)`,
      );
    } else {
      raw.images.forEach((entry, index) => {
        const result = validateImage(entry, `images[${index}]`);
        errors.push(...result.errors);
        totalBytes += result.bytes;
        if (result.image) images.push(result.image);
      });
    }
  }

  if (totalBytes > MAX_REQUEST_IMAGE_BYTES) {
    errors.push(
      `images (${totalBytes} bytes of image data, over the ${mb(MAX_REQUEST_IMAGE_BYTES)} per-request limit)`,
    );
  }

  return { images, screenshot, errors };
}
