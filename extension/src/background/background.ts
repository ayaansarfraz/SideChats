import type {
  CaptureRegionRequest,
  CreateSideChatRequest,
  ExtensionRequest,
  ExtensionResponse,
  SendMessageRequest,
  StartRegionCaptureMessage,
} from "../shared/messages";
import { ImageRejectedError, processImage, toCaptureBox } from "../shared/image";

const API_BASE = "http://localhost:3000/api/side-chats";

export async function handleRequest(
  request: CreateSideChatRequest | SendMessageRequest,
): Promise<ExtensionResponse> {
  try {
    if (request.type === "CREATE_SIDE_CHAT") {
      const res = await fetch(API_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.payload),
      });

      if (!res.ok) {
        const error = await extractError(res);
        return { ok: false, error, errorType: "http" };
      }

      const data = (await res.json()) as { sideChatId: string; reply: string };
      return { ok: true, kind: "reply", sideChatId: data.sideChatId, reply: data.reply };
    }

    // SEND_MESSAGE
    const { sideChatId, question, images } = request.payload;
    const res = await fetch(`${API_BASE}/${encodeURIComponent(sideChatId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, ...(images?.length ? { images } : {}) }),
    });

    if (!res.ok) {
      const error = await extractError(res);
      return { ok: false, error, errorType: "http" };
    }

    const data = (await res.json()) as { reply: string };
    return { ok: true, kind: "reply", sideChatId, reply: data.reply };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network request failed";
    return { ok: false, error: message, errorType: "network" };
  }
}

async function extractError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed with status ${res.status}`;
  } catch {
    return `Request failed with status ${res.status}`;
  }
}

/**
 * Photograph the visible tab and crop the requested region out of it.
 *
 * Only the worker can do this: `chrome.tabs.captureVisibleTab` is unavailable
 * to content scripts, and it needs `<all_urls>` in `host_permissions` (measured
 * — see BUILD_PLAN.md; per-site hosts fail and `activeTab` dies on navigation).
 * It photographs the whole viewport at device resolution, so the rectangle the
 * page sends in CSS pixels has to be scaled by its `devicePixelRatio` before it
 * lines up with the capture — that scaling and its clamping live in
 * `toCaptureBox`.
 *
 * `windowId` comes from the sending tab. Passing it explicitly rather than
 * relying on "the current window" matters because the worker has no window of
 * its own, and the last-focused one is not necessarily the tab that asked.
 */
export async function handleCaptureRegion(
  request: CaptureRegionRequest,
  windowId?: number,
): Promise<ExtensionResponse> {
  const { rect, devicePixelRatio } = request.payload;

  try {
    const dataUrl =
      typeof windowId === "number"
        ? await chrome.tabs.captureVisibleTab(windowId, { format: "png" })
        : await chrome.tabs.captureVisibleTab({ format: "png" });

    if (!dataUrl) {
      return { ok: false, error: "Chrome returned an empty screenshot.", errorType: "network" };
    }

    const shot = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(shot);

    try {
      const box = toCaptureBox(rect, devicePixelRatio, {
        width: bitmap.width,
        height: bitmap.height,
      });
      if (box.width < 1 || box.height < 1) {
        return {
          ok: false,
          error: "That region fell outside the visible page — try dragging again.",
          errorType: "network",
        };
      }

      const canvas = new OffscreenCanvas(box.width, box.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return { ok: false, error: "Couldn't crop the screenshot.", errorType: "network" };
      }
      ctx.drawImage(bitmap, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);

      const cropped = await canvas.convertToBlob({ type: "image/png" });
      // Re-uses the same downscale/encode/size rules the composer applies to a
      // pasted or attached image, so a screenshot is capped identically.
      const image = await processImage(cropped);
      return { ok: true, kind: "image", image };
    } finally {
      bitmap.close();
    }
  } catch (err) {
    // `errorType` has no "capture" arm — it discriminates where a *request*
    // failed, and this never reached the server. "network" is the honest one of
    // the two: something outside our code refused, and the message says what.
    const message =
      err instanceof ImageRejectedError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Couldn't capture that region.";
    return { ok: false, error: message, errorType: "network" };
  }
}

/**
 * A click on the toolbar icon starts a region capture in that tab.
 *
 * Background → content is a direction this extension didn't previously have:
 * every other message goes the other way. `chrome.tabs.sendMessage` rejects
 * when the tab has no content script listening — a `chrome://` page, or any
 * host outside the manifest's `matches` — which is a no-op, not a failure.
 */
export async function startRegionCapture(tab: chrome.tabs.Tab): Promise<void> {
  if (typeof tab.id !== "number") return;
  const message: StartRegionCaptureMessage = { type: "START_REGION_CAPTURE" };
  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    // Nothing listening on that tab. SideChats simply doesn't run there.
  }
}

chrome.action.onClicked.addListener(startRegionCapture);

chrome.runtime.onMessage.addListener((request: ExtensionRequest, sender, sendResponse) => {
  if (request.type === "CREATE_SIDE_CHAT" || request.type === "SEND_MESSAGE") {
    handleRequest(request).then(sendResponse);
    return true; // keep the message channel open for the async response
  }

  if (request.type === "CAPTURE_REGION") {
    handleCaptureRegion(request, sender.tab?.windowId).then(sendResponse);
    return true;
  }

  return false;
});

console.log("[SideChats] background service worker started");
