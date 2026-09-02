import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  MAX_REQUEST_IMAGE_BYTES,
  decodedByteSize,
  validateImageFields,
} from "./images.js";

/** Base64 that decodes to at least `bytes`, without allocating the bytes. */
function base64OfSize(bytes: number): string {
  return "A".repeat(Math.ceil(bytes / 3) * 4);
}

const PNG = Buffer.from("fake-png-bytes").toString("base64");

function image(overrides: Record<string, unknown> = {}) {
  return { id: "img-1", mediaType: "image/png", data: PNG, width: 800, height: 600, ...overrides };
}

describe("decodedByteSize", () => {
  it("matches Buffer's own decode for every padding case", () => {
    for (const source of ["a", "ab", "abc", "abcd", "abcde", ""]) {
      const encoded = Buffer.from(source).toString("base64");
      expect(decodedByteSize(encoded)).toBe(Buffer.byteLength(source));
    }
  });
});

describe("validateImageFields", () => {
  it("accepts a body with no image fields at all — the text-only path", () => {
    const result = validateImageFields({});
    expect(result.errors).toEqual([]);
    expect(result.images).toEqual([]);
    expect(result.screenshot).toBeUndefined();
  });

  it("accepts valid images and a valid screenshot", () => {
    const result = validateImageFields({
      images: [image(), image({ id: "img-2", mediaType: "image/jpeg" })],
      screenshot: image({ id: "shot" }),
    });
    expect(result.errors).toEqual([]);
    expect(result.images.map((i) => i.id)).toEqual(["img-1", "img-2"]);
    expect(result.screenshot?.id).toBe("shot");
  });

  it("drops fields the wire format doesn't have, rather than storing them", () => {
    // `byteSize` is the extension's client-side cap bookkeeping. Echoing an
    // unknown field back into the API request is how a future client-only
    // field turns into a 400 from Anthropic.
    const result = validateImageFields({ images: [image({ byteSize: 4242, nonsense: true })] });
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.images[0]).sort()).toEqual([
      "data",
      "height",
      "id",
      "mediaType",
      "width",
    ]);
  });

  it("rejects a non-array images field", () => {
    const result = validateImageFields({ images: "not-an-array" });
    expect(result.errors).toEqual(["images (must be an array)"]);
  });

  it("rejects more than three images, saying how many arrived", () => {
    const result = validateImageFields({ images: [image(), image(), image(), image()] });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("images (4 images");
    expect(result.errors[0]).toContain("at most 3");
  });

  it("names the offending index and field for a bad mediaType", () => {
    const result = validateImageFields({
      images: [image(), image({ id: "img-2", mediaType: "image/svg+xml" })],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("images[1].mediaType");
    // The good sibling is not implicated.
    expect(result.errors[0]).not.toContain("images[0]");
  });

  it("names every bad field on one image, not just the first", () => {
    const result = validateImageFields({
      images: [{ id: "", mediaType: "image/png", data: PNG, width: 0, height: -3 }],
    });
    expect(result.errors.join("; ")).toContain("images[0].id");
    expect(result.errors.join("; ")).toContain("images[0].width");
    expect(result.errors.join("; ")).toContain("images[0].height");
  });

  it("rejects a data: URL prefix — the API wants bare base64", () => {
    const result = validateImageFields({
      images: [image({ data: `data:image/png;base64,${PNG}` })],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("images[0].data");
    expect(result.errors[0]).toContain("base64");
  });

  it("rejects non-base64 characters", () => {
    const result = validateImageFields({ images: [image({ data: "abc!@#$" })] });
    expect(result.errors[0]).toContain("images[0].data");
  });

  it("rejects an image over the per-image byte cap, quoting its real size", () => {
    const oversize = base64OfSize(MAX_IMAGE_BYTES + 1024);
    const result = validateImageFields({ images: [image({ data: oversize })] });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("images[0].data");
    expect(result.errors[0]).toContain("2 MB per-image limit");
    // Exact bytes, not a rounded "2.0 MB over the 2.0 MB limit" that reads as
    // a contradiction for an image only slightly over.
    expect(result.errors[0]).toMatch(/\(\d{7} bytes decoded/);
  });

  it("re-derives size from the bytes, ignoring a client-reported byteSize", () => {
    // A client-reported size is not a limit. This one claims to be tiny.
    const result = validateImageFields({
      images: [image({ data: base64OfSize(MAX_IMAGE_BYTES + 1024), byteSize: 12 })],
    });
    expect(result.errors[0]).toContain("over the");
  });

  it("rejects a request whose images are individually fine but too big together", () => {
    const each = base64OfSize(1.8 * 1024 * 1024);
    const result = validateImageFields({
      images: [image({ data: each }), image({ id: "b", data: each }), image({ id: "c", data: each })],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("per-request limit");
    expect(MAX_REQUEST_IMAGE_BYTES).toBe(5 * 1024 * 1024);
  });

  it("counts the screenshot toward the per-request total", () => {
    const big = base64OfSize(1.9 * 1024 * 1024);
    const result = validateImageFields({
      images: [image({ data: big }), image({ id: "b", data: big })],
      screenshot: image({ id: "shot", data: big }),
    });
    expect(result.errors.join("; ")).toContain("per-request limit");
  });

  it("validates the screenshot with the same rules as an attachment", () => {
    const result = validateImageFields({ screenshot: { id: "shot", mediaType: "image/tiff" } });
    const joined = result.errors.join("; ");
    expect(joined).toContain("screenshot.mediaType");
    expect(joined).toContain("screenshot.data");
    expect(result.screenshot).toBeUndefined();
  });

  it("rejects a non-object image entry", () => {
    const result = validateImageFields({ images: ["not-an-object"] });
    expect(result.errors).toEqual(["images[0] (must be an object)"]);
  });
});
