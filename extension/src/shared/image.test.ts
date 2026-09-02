import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ImageRejectedError,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_LONG_EDGE,
  PNG_FALLBACK_BYTES,
  blobToBase64,
  fitScale,
  isSupportedMediaType,
  processImage,
  toCaptureBox,
  toDataUrl,
} from "./image";

/**
 * jsdom has neither `createImageBitmap` nor `OffscreenCanvas`, so without these
 * stubs every processImage test would throw for the wrong reason. The stubs are
 * deliberately dumb: they report whatever dimensions and encoded sizes the test
 * asks for, so what's actually under test is image.ts's decision logic —
 * when to downscale, when to fall back to JPEG, when to give up — rather than
 * any real codec behaviour.
 */
const dimensions = new WeakMap<Blob, { width: number; height: number }>();

/** Encoded size, in bytes, the fake canvas reports per output format. */
let encodedSizes: Record<string, number> = {};
/** Every convertToBlob call, so tests can assert which formats were tried. */
let encodeCalls: Array<{ type: string; quality?: number; width: number; height: number }> = [];

function fakeImageBlob(opts: {
  width: number;
  height: number;
  bytes: number;
  type?: string;
}): Blob {
  const blob = new Blob([new Uint8Array(opts.bytes)], { type: opts.type ?? "image/png" });
  dimensions.set(blob, { width: opts.width, height: opts.height });
  return blob;
}

beforeEach(() => {
  encodedSizes = {};
  encodeCalls = [];

  vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
    const dims = dimensions.get(blob) ?? { width: 100, height: 100 };
    return { width: dims.width, height: dims.height, close: () => {} };
  });

  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { drawImage: () => {} };
      }
      async convertToBlob({ type, quality }: { type: string; quality?: number }) {
        encodeCalls.push({ type, quality, width: this.width, height: this.height });
        const size = encodedSizes[type] ?? 1024;
        return new Blob([new Uint8Array(size)], { type });
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isSupportedMediaType", () => {
  it("accepts the four formats the API takes", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(isSupportedMediaType(type)).toBe(true);
    }
  });

  it("rejects everything else, including an empty type", () => {
    expect(isSupportedMediaType("image/svg+xml")).toBe(false);
    expect(isSupportedMediaType("application/pdf")).toBe(false);
    expect(isSupportedMediaType("")).toBe(false);
  });
});

describe("fitScale", () => {
  it("leaves an image already inside the budget alone", () => {
    expect(fitScale(800, 600)).toBe(1);
    expect(fitScale(MAX_IMAGE_LONG_EDGE, 400)).toBe(1);
  });

  it("scales by whichever edge is longer", () => {
    expect(fitScale(3136, 400)).toBeCloseTo(0.5);
    expect(fitScale(400, 3136)).toBeCloseTo(0.5);
  });
});

describe("blobToBase64", () => {
  it("returns bare base64 with no data: prefix", async () => {
    const blob = new Blob([new Uint8Array([104, 105])], { type: "image/png" });
    const base64 = await blobToBase64(blob);
    expect(base64).toBe("aGk=");
    expect(base64).not.toContain("data:");
  });

  it("survives a payload past the fromCharCode argument limit", async () => {
    const blob = new Blob([new Uint8Array(0x8000 * 2 + 5)], { type: "image/png" });
    await expect(blobToBase64(blob)).resolves.toBeTypeOf("string");
  });
});

describe("processImage", () => {
  it("rejects an unsupported format by name, without decoding it", async () => {
    const blob = new Blob(["<svg/>"], { type: "image/svg+xml" });
    await expect(processImage(blob)).rejects.toThrow(ImageRejectedError);
    await expect(processImage(blob)).rejects.toThrow(/PNG, JPEG, WebP, or GIF/);
    expect(encodeCalls).toHaveLength(0);
  });

  it("passes a small, in-budget image through without re-encoding it", async () => {
    const blob = fakeImageBlob({ width: 800, height: 600, bytes: 4096, type: "image/png" });
    const attachment = await processImage(blob);

    expect(encodeCalls).toHaveLength(0);
    expect(attachment.width).toBe(800);
    expect(attachment.height).toBe(600);
    expect(attachment.mediaType).toBe("image/png");
    expect(attachment.byteSize).toBe(4096);
  });

  it("downscales to the long-edge budget, preserving aspect ratio", async () => {
    const blob = fakeImageBlob({ width: 3136, height: 1568, bytes: 4096 });
    encodedSizes = { "image/png": 2048 };

    const attachment = await processImage(blob);

    expect(attachment.width).toBe(MAX_IMAGE_LONG_EDGE);
    expect(attachment.height).toBe(MAX_IMAGE_LONG_EDGE / 2);
    expect(encodeCalls).toEqual([
      { type: "image/png", quality: undefined, width: 1568, height: 784 },
    ]);
  });

  it("falls back to JPEG only once PNG exceeds the threshold", async () => {
    const blob = fakeImageBlob({ width: 4000, height: 2000, bytes: 10 });
    encodedSizes = { "image/png": PNG_FALLBACK_BYTES + 1, "image/jpeg": 500_000 };

    const attachment = await processImage(blob);

    expect(encodeCalls.map((c) => c.type)).toEqual(["image/png", "image/jpeg"]);
    expect(attachment.mediaType).toBe("image/jpeg");
    expect(attachment.byteSize).toBe(500_000);
  });

  it("keeps PNG when it lands exactly on the threshold", async () => {
    const blob = fakeImageBlob({ width: 4000, height: 2000, bytes: 10 });
    encodedSizes = { "image/png": PNG_FALLBACK_BYTES };

    const attachment = await processImage(blob);

    expect(encodeCalls.map((c) => c.type)).toEqual(["image/png"]);
    expect(attachment.mediaType).toBe("image/png");
  });

  it("rejects an image still over the cap after JPEG compression", async () => {
    const blob = fakeImageBlob({ width: 4000, height: 2000, bytes: 10 });
    encodedSizes = {
      "image/png": PNG_FALLBACK_BYTES + 1,
      "image/jpeg": MAX_IMAGE_BYTES + 1,
    };

    await expect(processImage(blob)).rejects.toThrow(ImageRejectedError);
    await expect(processImage(blob)).rejects.toThrow(/the limit is 2 MB/);
  });

  it("re-encodes an in-budget-size image that is over the cap", async () => {
    // No downscale needed, but the original bytes are too big to send as-is.
    const blob = fakeImageBlob({ width: 800, height: 600, bytes: MAX_IMAGE_BYTES + 1 });
    encodedSizes = { "image/png": 1000 };

    const attachment = await processImage(blob);

    expect(encodeCalls).toHaveLength(1);
    expect(attachment.byteSize).toBe(1000);
  });
});

describe("toCaptureBox", () => {
  it("passes a rect through unchanged at dPR 1", () => {
    expect(toCaptureBox({ x: 10, y: 20, width: 100, height: 50 }, 1)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it("scales to device pixels", () => {
    expect(toCaptureBox({ x: 10, y: 20, width: 100, height: 50 }, 2)).toEqual({
      x: 20,
      y: 40,
      width: 200,
      height: 100,
    });
  });

  it("normalizes a drag made right-to-left and bottom-to-top", () => {
    expect(toCaptureBox({ x: 110, y: 70, width: -100, height: -50 }, 1)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it("clamps a drag that ran off the edge of the capture", () => {
    const box = toCaptureBox({ x: 900, y: 500, width: 400, height: 400 }, 1, {
      width: 1000,
      height: 800,
    });
    expect(box).toEqual({ x: 900, y: 500, width: 100, height: 300 });
  });

  it("clamps an origin outside the capture to a zero-area box rather than negatives", () => {
    const box = toCaptureBox({ x: -50, y: -50, width: 10, height: 10 }, 1, {
      width: 100,
      height: 100,
    });
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
    expect(box.width).toBeGreaterThanOrEqual(0);
    expect(box.height).toBeGreaterThanOrEqual(0);
  });

  it("rounds fractional CSS pixels at fractional dPR", () => {
    const box = toCaptureBox({ x: 10.4, y: 10.6, width: 100.5, height: 100.5 }, 1.5);
    expect(Number.isInteger(box.x)).toBe(true);
    expect(Number.isInteger(box.width)).toBe(true);
    expect(box).toEqual({ x: 16, y: 16, width: 151, height: 151 });
  });
});

describe("toDataUrl", () => {
  it("rebuilds the prefix the attachment deliberately doesn't carry", () => {
    expect(
      toDataUrl({
        id: "1",
        mediaType: "image/jpeg",
        data: "aGk=",
        width: 1,
        height: 1,
        byteSize: 2,
      }),
    ).toBe("data:image/jpeg;base64,aGk=");
  });
});
