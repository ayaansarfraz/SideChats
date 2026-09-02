import Anthropic from "@anthropic-ai/sdk";
import type { Message, SideChat, StoredImage } from "../types.js";
import { buildSystemPrompt } from "./contextPackage.js";

const anthropic = new Anthropic();
const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

/**
 * A turn with no images stays a plain string — that keeps the request byte-for-byte
 * what the text-only path has always sent. With images it becomes a content-block
 * array, images first: for image Q&A the model does better seeing the picture
 * before the question about it.
 */
function buildContent(text: string, images: StoredImage[]): Anthropic.MessageParam["content"] {
  if (images.length === 0) return text;

  return [
    ...images.map((image) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: image.mediaType,
        data: image.data,
      },
    })),
    // An image with no words is a legitimate "what is this?" — the system
    // prompt carries the intent. An empty text block would be a 400.
    ...(text ? [{ type: "text" as const, text }] : []),
  ];
}

export async function askSideChat(
  sideChat: SideChat,
  question: string,
  images: StoredImage[] = [],
): Promise<string> {
  const system = buildSystemPrompt({
    parentUserMessage: sideChat.parentUserMessage,
    parentAiResponse: sideChat.parentAiResponse,
    selectedText: sideChat.selectedText,
    priorContext: sideChat.priorContext,
    hasScreenshot: sideChat.screenshot !== undefined,
  });

  const turns: Message[] = [
    ...sideChat.messages,
    { role: "user", content: question, images: images.length > 0 ? images : undefined },
  ];

  // The branch-point screenshot is stored once on the SideChat, not duplicated
  // into messages[0].images, so it is re-attached here on every call. The API
  // is stateless; the extension still only ever uploads those bytes once.
  const firstUserTurn = turns.findIndex((turn) => turn.role === "user");

  const messages: Anthropic.MessageParam[] = turns.map((turn, index) => {
    const attached =
      index === firstUserTurn && sideChat.screenshot
        ? [sideChat.screenshot, ...(turn.images ?? [])]
        : (turn.images ?? []);
    return { role: turn.role, content: buildContent(turn.content, attached) };
  });

  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    system,
    messages,
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Anthropic response contained no text content");
  }
  return textBlock.text;
}
