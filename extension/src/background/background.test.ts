// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  handleCaptureRegion as HandleCaptureRegionType,
  handleRequest as HandleRequestType,
  startRegionCapture as StartRegionCaptureType,
} from "./background";
import { MAX_IMAGE_LONG_EDGE } from "../shared/image";

// background.ts registers chrome.runtime.onMessage and chrome.action.onClicked
// listeners at module scope, so `chrome` must be stubbed before the module is
// ever imported. A dynamic import (inside beforeAll, after the stub) avoids
// static-import hoisting.
let handleRequest: typeof HandleRequestType;
let handleCaptureRegion: typeof HandleCaptureRegionType;
let startRegionCapture: typeof StartRegionCaptureType;

/** Every listener background.ts registered at import time, for direct calls. */
const onMessageListeners: Array<
  (
    request: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => boolean
> = [];
const onClickedListeners: Array<(tab: chrome.tabs.Tab) => void> = [];

const captureVisibleTab = vi.fn();
const tabsSendMessage = vi.fn();

beforeAll(async () => {
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: {
        addListener: vi.fn((fn) => onMessageListeners.push(fn)),
      },
    },
    action: {
      onClicked: { addListener: vi.fn((fn) => onClickedListeners.push(fn)) },
    },
    tabs: { captureVisibleTab, sendMessage: tabsSendMessage },
  });
  ({ handleRequest, handleCaptureRegion, startRegionCapture } = await import("./background"));
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  captureVisibleTab.mockReset();
  tabsSendMessage.mockReset();
});

const createPayload = {
  selectedText: "timeslice",
  parentUserMessage: "Explain the OS scheduler.",
  parentAiResponse: "The kernel context-switches after a timeslice.",
  question: "What does that mean?",
};

describe("handleRequest", () => {
  it("returns ok:true with sideChatId and reply on a successful CREATE_SIDE_CHAT", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ sideChatId: "abc", reply: "a reply" }), { status: 201 }),
    );

    const res = await handleRequest({ type: "CREATE_SIDE_CHAT", payload: createPayload });

    expect(res).toEqual({ ok: true, kind: "reply", sideChatId: "abc", reply: "a reply" });
  });

  it("returns ok:false, errorType:'http' with the server's error body on a non-2xx response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "Failed to get a reply from the model" }), { status: 502 }),
    );

    const res = await handleRequest({ type: "CREATE_SIDE_CHAT", payload: createPayload });

    expect(res).toEqual({
      ok: false,
      error: "Failed to get a reply from the model",
      errorType: "http",
    });
  });

  it("falls back to a status-based message when a non-2xx response has no JSON body", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("not json", { status: 500 }));

    const res = await handleRequest({
      type: "SEND_MESSAGE",
      payload: { sideChatId: "abc", question: "q" },
    });

    expect(res).toEqual({ ok: false, error: "Request failed with status 500", errorType: "http" });
  });

  it("returns ok:false, errorType:'network' when fetch throws (server unreachable)", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Failed to fetch"));

    const res = await handleRequest({ type: "CREATE_SIDE_CHAT", payload: createPayload });

    expect(res).toEqual({ ok: false, error: "Failed to fetch", errorType: "network" });
  });

  it("relays SEND_MESSAGE success with the given sideChatId", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ reply: "follow-up reply" }), { status: 200 }),
    );

    const res = await handleRequest({
      type: "SEND_MESSAGE",
      payload: { sideChatId: "abc", question: "why does that matter?" },
    });

    expect(res).toEqual({ ok: true, kind: "reply", sideChatId: "abc", reply: "follow-up reply" });
  });
});

/**
 * A stand-in for the screenshot Chrome hands back. jsdom has neither
 * `createImageBitmap` nor `OffscreenCanvas`, so the crop is driven through
 * fakes that record what they were asked to draw — what is under test here is
 * the rect maths and the wiring, not a real codec.
 */
type DrawCall = {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  canvasWidth: number;
  canvasHeight: number;
};

let drawCalls: DrawCall[] = [];

/**
 * Dimensions of every blob the fake canvas produced. The crop is decoded a
 * second time by `processImage`, so without this the stub would hand it the
 * *viewport's* size and the downscale decision would be made against the wrong
 * numbers — the exact thing these tests exist to check.
 */
const blobDimensions = new WeakMap<Blob, { width: number; height: number }>();

function stubCanvasPipeline(capture: { width: number; height: number }): void {
  drawCalls = [];
  vi.mocked(fetch).mockResolvedValue(new Response(new Blob([new Uint8Array(8)])));
  vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
    const dims = blobDimensions.get(blob) ?? capture;
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
        return {
          drawImage: (
            _bitmap: unknown,
            sx: number,
            sy: number,
            sw: number,
            sh: number,
          ) => {
            drawCalls.push({
              sx,
              sy,
              sw,
              sh,
              canvasWidth: this.width,
              canvasHeight: this.height,
            });
          },
        };
      }
      async convertToBlob({ type }: { type: string }) {
        const blob = new Blob([new Uint8Array(64)], { type });
        blobDimensions.set(blob, { width: this.width, height: this.height });
        return blob;
      }
    },
  );
}

describe("handleCaptureRegion", () => {
  it("crops the device-pixel box matching the CSS rect at dPR 1", async () => {
    stubCanvasPipeline({ width: 1000, height: 800 });
    captureVisibleTab.mockResolvedValue("data:image/png;base64,AAAA");

    const res = await handleCaptureRegion(
      {
        type: "CAPTURE_REGION",
        payload: { rect: { x: 10, y: 20, width: 200, height: 100 }, devicePixelRatio: 1 },
      },
      7,
    );

    expect(res).toMatchObject({ ok: true, kind: "image" });
    expect(drawCalls).toEqual([
      { sx: 10, sy: 20, sw: 200, sh: 100, canvasWidth: 200, canvasHeight: 100 },
    ]);
  });

  it("scales the rect by devicePixelRatio, because the capture is at device resolution", async () => {
    stubCanvasPipeline({ width: 2000, height: 1600 });
    captureVisibleTab.mockResolvedValue("data:image/png;base64,AAAA");

    await handleCaptureRegion(
      {
        type: "CAPTURE_REGION",
        payload: { rect: { x: 10, y: 20, width: 200, height: 100 }, devicePixelRatio: 2 },
      },
      7,
    );

    expect(drawCalls).toEqual([
      { sx: 20, sy: 40, sw: 400, sh: 200, canvasWidth: 400, canvasHeight: 200 },
    ]);
  });

  it("clamps a drag that ran past the edge of the window to the captured image", async () => {
    stubCanvasPipeline({ width: 400, height: 300 });
    captureVisibleTab.mockResolvedValue("data:image/png;base64,AAAA");

    await handleCaptureRegion(
      {
        type: "CAPTURE_REGION",
        payload: { rect: { x: 300, y: 200, width: 500, height: 500 }, devicePixelRatio: 1 },
      },
      7,
    );

    expect(drawCalls).toEqual([
      { sx: 300, sy: 200, sw: 100, sh: 100, canvasWidth: 100, canvasHeight: 100 },
    ]);
  });

  it("reports the region's own dimensions on the attachment, not the viewport's", async () => {
    stubCanvasPipeline({ width: 2000, height: 1600 });
    captureVisibleTab.mockResolvedValue("data:image/png;base64,AAAA");

    const res = await handleCaptureRegion({
      type: "CAPTURE_REGION",
      payload: { rect: { x: 0, y: 0, width: 300, height: 150 }, devicePixelRatio: 2 },
    });

    expect(res).toMatchObject({
      ok: true,
      kind: "image",
      image: { mediaType: "image/png", width: 600, height: 300 },
    });
  });

  it("downscales an oversized region through the shared image rules", async () => {
    stubCanvasPipeline({ width: 6000, height: 4000 });
    captureVisibleTab.mockResolvedValue("data:image/png;base64,AAAA");

    const res = await handleCaptureRegion({
      type: "CAPTURE_REGION",
      payload: { rect: { x: 0, y: 0, width: 3000, height: 2000 }, devicePixelRatio: 2 },
    });

    expect(res).toMatchObject({ ok: true, kind: "image" });
    if (!res.ok || res.kind !== "image") throw new Error("expected an image response");
    expect(Math.max(res.image.width, res.image.height)).toBe(MAX_IMAGE_LONG_EDGE);
  });

  it("passes the sending tab's windowId so it photographs the right window", async () => {
    stubCanvasPipeline({ width: 400, height: 300 });
    captureVisibleTab.mockResolvedValue("data:image/png;base64,AAAA");

    await handleCaptureRegion(
      {
        type: "CAPTURE_REGION",
        payload: { rect: { x: 0, y: 0, width: 100, height: 100 }, devicePixelRatio: 1 },
      },
      42,
    );

    expect(captureVisibleTab).toHaveBeenCalledWith(42, { format: "png" });
  });

  it("returns an error rather than throwing when Chrome refuses the capture", async () => {
    stubCanvasPipeline({ width: 400, height: 300 });
    captureVisibleTab.mockRejectedValue(new Error("Cannot access contents of the page."));

    const res = await handleCaptureRegion({
      type: "CAPTURE_REGION",
      payload: { rect: { x: 0, y: 0, width: 100, height: 100 }, devicePixelRatio: 1 },
    });

    expect(res).toEqual({
      ok: false,
      error: "Cannot access contents of the page.",
      errorType: "network",
    });
  });

  it("rejects a region that clamps away to nothing instead of cropping an empty canvas", async () => {
    stubCanvasPipeline({ width: 400, height: 300 });
    captureVisibleTab.mockResolvedValue("data:image/png;base64,AAAA");

    const res = await handleCaptureRegion({
      type: "CAPTURE_REGION",
      // Entirely below the captured viewport — nothing of it was photographed.
      payload: { rect: { x: 0, y: 900, width: 200, height: 100 }, devicePixelRatio: 1 },
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected a failure");
    expect(res.error).toMatch(/outside the visible page/);
    expect(drawCalls).toEqual([]);
  });
});

describe("startRegionCapture", () => {
  it("relays START_REGION_CAPTURE to the clicked tab", async () => {
    tabsSendMessage.mockResolvedValue(undefined);

    await startRegionCapture({ id: 12 } as chrome.tabs.Tab);

    expect(tabsSendMessage).toHaveBeenCalledWith(12, { type: "START_REGION_CAPTURE" });
  });

  it("swallows the rejection on a tab with no content script listening", async () => {
    tabsSendMessage.mockRejectedValue(new Error("Could not establish connection."));

    await expect(startRegionCapture({ id: 12 } as chrome.tabs.Tab)).resolves.toBeUndefined();
  });

  it("does nothing for a tab with no id", async () => {
    await startRegionCapture({} as chrome.tabs.Tab);

    expect(tabsSendMessage).not.toHaveBeenCalled();
  });

  it("is the registered chrome.action.onClicked handler", () => {
    expect(onClickedListeners).toHaveLength(1);
    expect(onClickedListeners[0]).toBe(startRegionCapture);
  });
});

describe("onMessage listener", () => {
  function dispatch(request: unknown, sender: chrome.runtime.MessageSender = {}) {
    const sendResponse = vi.fn();
    const keptOpen = onMessageListeners[0](request, sender, sendResponse);
    return { keptOpen, sendResponse };
  }

  it("answers CAPTURE_REGION and keeps the channel open for the async crop", async () => {
    stubCanvasPipeline({ width: 400, height: 300 });
    captureVisibleTab.mockResolvedValue("data:image/png;base64,AAAA");

    const { keptOpen, sendResponse } = dispatch(
      {
        type: "CAPTURE_REGION",
        payload: { rect: { x: 0, y: 0, width: 100, height: 100 }, devicePixelRatio: 1 },
      },
      { tab: { windowId: 5 } as chrome.tabs.Tab },
    );

    expect(keptOpen).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: true, kind: "image" });
    expect(captureVisibleTab).toHaveBeenCalledWith(5, { format: "png" });
  });

  it("declines a message it does not own rather than answering it", () => {
    expect(dispatch({ type: "SOMETHING_ELSE" }).keptOpen).toBe(false);
  });
});
