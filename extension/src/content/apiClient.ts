import type { ExtensionRequest, ExtensionResponse } from "../shared/messages";
import type { ContextPackage } from "../shared/types";

function sendToBackground(request: ExtensionRequest): Promise<ExtensionResponse> {
  return chrome.runtime.sendMessage(request);
}

export async function askSideChat(
  ctx: ContextPackage,
  question: string,
): Promise<{ sideChatId: string; reply: string }> {
  const response = await sendToBackground({
    type: "CREATE_SIDE_CHAT",
    payload: { ...ctx, question },
  });

  if (!response.ok) {
    throw new Error(response.error);
  }

  return { sideChatId: response.sideChatId, reply: response.reply };
}

export async function continueSideChat(
  sideChatId: string,
  question: string,
): Promise<{ reply: string }> {
  const response = await sendToBackground({
    type: "SEND_MESSAGE",
    payload: { sideChatId, question },
  });

  if (!response.ok) {
    throw new Error(response.error);
  }

  return { reply: response.reply };
}
