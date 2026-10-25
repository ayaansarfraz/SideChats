import { Router } from "express";
import { askSideChat } from "../lib/anthropicClient.js";
import { validateImageFields } from "../lib/images.js";
import { appendMessages, createSideChat, getSideChat, removeSideChat } from "../lib/store.js";
import type { Message } from "../types.js";

/**
 * Both 400 paths name the fields that actually failed rather than restating the
 * whole contract — a blanket error tells you nothing about which of three
 * attachments the client mis-encoded, or which part of the page's DOM stopped
 * extracting.
 */
function badRequest(missing: string[], invalid: string[]): string {
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`Missing or empty: ${missing.join(", ")}`);
  if (invalid.length > 0) parts.push(`Invalid: ${invalid.join("; ")}`);
  return parts.join(" — ");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * History a client sent to re-seed a side chat this store already swept.
 *
 * Validated rather than trusted, and dropped whole rather than repaired: the
 * Anthropic API rejects a `messages` array that doesn't alternate from a user
 * turn, and a request that 400s at the model is a worse outcome than a chat
 * that starts without the history the client hoped to restore. Images are
 * ignored — the branch point is already stored on the side chat.
 */
export function parseSeedMessages(value: unknown): Message[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  if (value.length % 2 !== 0) return [];

  const seeded: Message[] = [];
  for (const [index, item] of value.entries()) {
    const role = (item as Message | null)?.role;
    const content = (item as Message | null)?.content;
    const expected = index % 2 === 0 ? "user" : "assistant";
    if (role !== expected || typeof content !== "string") return [];
    seeded.push({ role, content });
  }
  return seeded;
}

export const sideChatsRouter = Router();

sideChatsRouter.post("/", async (req, res) => {
  const { parentUserMessage, parentAiResponse, selectedText, priorContext, question } = req.body ?? {};

  // Validate the images before anything touches the store, so a rejected
  // request leaves no side chat behind.
  const { images, screenshot, errors: invalid } = validateImageFields(req.body ?? {});
  const hasScreenshot = screenshot !== undefined;

  // parentUserMessage may legitimately be "" — the extension sends that
  // whenever the DOM has no preceding user turn to find, which happens for
  // the first message in a conversation and (on sites like ChatGPT that
  // virtualize long threads) for any turn whose preceding user message has
  // been unmounted from the DOM after scrolling. Only its type is required,
  // not that it's non-empty.
  //
  // A screenshot relaxes all three context fields: a dragged region may sit
  // outside any turn entirely (over a chart, a sidebar, a pasted picture), in
  // which case the DOM walk has nothing to report and sends empty strings.
  // The captured image is the branch point on its own.
  const missing: string[] = [];
  if (typeof parentUserMessage !== "string" && !hasScreenshot) missing.push("parentUserMessage");
  if (!parentAiResponse && !hasScreenshot) missing.push("parentAiResponse");
  if (!selectedText && !hasScreenshot) missing.push("selectedText");
  // An image with no words is a legitimate "what is this?" — the system prompt
  // carries the intent, so a question is only required when nothing else is.
  if (!question && !hasScreenshot && images.length === 0) missing.push("question");

  if (missing.length > 0 || invalid.length > 0) {
    const error = badRequest(missing, invalid);
    console.error("[SideChats] rejected create:", error);
    res.status(400).json({ error });
    return;
  }

  const sideChat = createSideChat({
    parentUserMessage: asString(parentUserMessage),
    parentAiResponse: asString(parentAiResponse),
    selectedText: asString(selectedText),
    priorContext,
    screenshot,
    messages: parseSeedMessages(req.body?.priorMessages),
  });

  try {
    const reply = await askSideChat(sideChat, asString(question), images);
    appendMessages(sideChat.id, [
      { role: "user", content: asString(question), images: images.length > 0 ? images : undefined },
      { role: "assistant", content: reply },
    ]);
    res.status(201).json({ sideChatId: sideChat.id, reply });
  } catch (err) {
    console.error("[SideChats] askSideChat failed (create):", err);
    removeSideChat(sideChat.id);
    res.status(502).json({ error: "Failed to get a reply from the model" });
  }
});

sideChatsRouter.post("/:id/messages", async (req, res) => {
  const { question } = req.body ?? {};
  const sideChat = getSideChat(req.params.id);

  if (!sideChat) {
    res.status(404).json({ error: "Side chat not found" });
    return;
  }

  // `screenshot` is a create-only field: the branch point is fixed once the
  // side chat exists, and a follow-up's pictures are ordinary attachments.
  const { images, errors: invalid } = validateImageFields({ images: req.body?.images });

  if (invalid.length > 0) {
    const error = badRequest([], invalid);
    console.error("[SideChats] rejected message:", error);
    res.status(400).json({ error });
    return;
  }
  if (!question && images.length === 0) {
    res.status(400).json({ error: "question is required unless an image is attached" });
    return;
  }

  try {
    const reply = await askSideChat(sideChat, asString(question), images);
    appendMessages(sideChat.id, [
      { role: "user", content: asString(question), images: images.length > 0 ? images : undefined },
      { role: "assistant", content: reply },
    ]);
    res.json({ reply });
  } catch (err) {
    console.error("[SideChats] askSideChat failed (continue):", err);
    res.status(502).json({ error: "Failed to get a reply from the model" });
  }
});

sideChatsRouter.delete("/:id", (req, res) => {
  const removed = removeSideChat(req.params.id);
  if (!removed) {
    res.status(404).json({ error: "Side chat not found" });
    return;
  }
  res.status(204).send();
});
