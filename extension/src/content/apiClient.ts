import type { ExtensionRequest, ExtensionResponse } from "../shared/messages";
import type { ContextPackage, ImageAttachment } from "../shared/types";
import {
  ExtensionContextInvalidatedError,
  isContextInvalidatedError,
  isExtensionAlive,
} from "./runtime";

async function sendToBackground(request: ExtensionRequest): Promise<ExtensionResponse> {
  // Checked up front so a dead context reads as one clear condition rather than
  // whatever error the call happens to throw on the way out.
  if (!isExtensionAlive()) throw new ExtensionContextInvalidatedError();

  let response: ExtensionResponse | undefined;
  try {
    response = await chrome.runtime.sendMessage(request);
  } catch (err) {
    if (isContextInvalidatedError(err) || !isExtensionAlive()) {
      throw new ExtensionContextInvalidatedError();
    }
    throw err;
  }

  // sendMessage resolves undefined when nothing answered — the service worker
  // died mid-flight, or was replaced between the liveness check and the send.
  if (!response) throw new ExtensionContextInvalidatedError();

  return response;
}

export async function askSideChat(
  ctx: ContextPackage,
  question: string,
  images: ImageAttachment[] = [],
): Promise<{ sideChatId: string; reply: string }> {
  const response = await sendToBackground({
    type: "CREATE_SIDE_CHAT",
    payload: { ...ctx, question, ...(images.length ? { images } : {}) },
  });

  if (!response.ok) {
    throw new Error(response.error);
  }
  if (response.kind !== "reply") {
    throw new Error("Expected a reply from the side chat, got an image.");
  }

  return { sideChatId: response.sideChatId, reply: response.reply };
}

export async function continueSideChat(
  sideChatId: string,
  question: string,
  images: ImageAttachment[] = [],
): Promise<{ reply: string }> {
  const response = await sendToBackground({
    type: "SEND_MESSAGE",
    payload: { sideChatId, question, ...(images.length ? { images } : {}) },
  });

  if (!response.ok) {
    throw new Error(response.error);
  }
  if (response.kind !== "reply") {
    throw new Error("Expected a reply from the side chat, got an image.");
  }

  return { reply: response.reply };
}
