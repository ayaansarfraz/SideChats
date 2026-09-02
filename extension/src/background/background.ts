import type {
  CreateSideChatRequest,
  ExtensionRequest,
  ExtensionResponse,
  SendMessageRequest,
} from "../shared/messages";

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

chrome.runtime.onMessage.addListener((request: ExtensionRequest, _sender, sendResponse) => {
  if (request.type === "CREATE_SIDE_CHAT" || request.type === "SEND_MESSAGE") {
    handleRequest(request).then(sendResponse);
    return true; // keep the message channel open for the async response
  }

  // CAPTURE_REGION belongs to the region-capture lane (see SCREENSHOT_PLAN.md).
  // Nothing sends it yet, and answering it with a fake success would be worse
  // than not answering it at all.
  return false;
});

console.log("[SideChats] background service worker started");
