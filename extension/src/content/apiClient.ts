import type { ExtensionRequest, ExtensionResponse } from "../shared/messages";
import type { ChatMessage, ContextPackage, ImageAttachment } from "../shared/types";
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

/**
 * A rendered thread, reduced to history a new side chat can be seeded with.
 *
 * Two things have to be true of what goes on the wire, and neither is true of
 * the panel's own message list:
 *
 * - **It alternates, starting with a user turn.** A question whose answer
 *   errored out is kept in the panel (the user asked it; it belongs on screen)
 *   but leaves the list ragged, and the API refuses two user turns in a row.
 *   Those unanswered turns are dropped here.
 * - **It carries no images.** Re-uploading every screenshot in a restored
 *   thread would put megabytes back on the wire to re-establish context the
 *   branch-point screenshot already provides.
 */
export function toPriorMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const seeded: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const expected = seeded.length % 2 === 0 ? "user" : "assistant";
    if (message.role !== expected) continue;
    // A user turn followed immediately by another one never got an answer.
    if (message.role === "user" && messages[i + 1]?.role === "user") continue;
    seeded.push({ role: message.role, content: message.content });
  }

  // A trailing question with no answer after it — the last send failed.
  if (seeded.length % 2 === 1) seeded.pop();
  return seeded;
}

export async function askSideChat(
  ctx: ContextPackage,
  question: string,
  images: ImageAttachment[] = [],
  priorMessages: readonly ChatMessage[] = [],
): Promise<{ sideChatId: string; reply: string }> {
  const seeded = toPriorMessages(priorMessages);
  const response = await sendToBackground({
    type: "CREATE_SIDE_CHAT",
    payload: {
      ...ctx,
      question,
      ...(images.length ? { images } : {}),
      ...(seeded.length ? { priorMessages: seeded } : {}),
    },
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
    throw response.error === SIDE_CHAT_NOT_FOUND ? new SideChatGoneError() : new Error(response.error);
  }
  if (response.kind !== "reply") {
    throw new Error("Expected a reply from the side chat, got an image.");
  }

  return { reply: response.reply };
}

/** The server's 404 body for an id it no longer holds. */
const SIDE_CHAT_NOT_FOUND = "Side chat not found";

/**
 * The server has forgotten this side chat.
 *
 * Its store is in memory, so a restart (including every `tsx watch` reload in
 * development) or the 30-minute idle sweep drops chats the panel still shows —
 * and a restored panel holds onto that id across reloads.
 */
export class SideChatGoneError extends Error {
  constructor() {
    super(SIDE_CHAT_NOT_FOUND);
    this.name = "SideChatGoneError";
  }
}

/**
 * Ask the next question of a side chat, whether or not the server still has it.
 *
 * A chat the server has dropped is re-created from the branch point and seeded
 * with `thread` (the messages before this question), so the user never sees the
 * server's bookkeeping — the conversation just carries on.
 */
export async function sendSideChatQuestion(
  ctx: ContextPackage,
  sideChatId: string | null,
  question: string,
  images: ImageAttachment[],
  thread: readonly ChatMessage[],
): Promise<{ reply: string; sideChatId?: string }> {
  if (sideChatId) {
    try {
      return await continueSideChat(sideChatId, question, images);
    } catch (err) {
      if (!(err instanceof SideChatGoneError)) throw err;
    }
  }
  return askSideChat(ctx, question, images, thread);
}
