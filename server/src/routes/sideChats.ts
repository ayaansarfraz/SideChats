import { Router } from "express";
import { askSideChat } from "../lib/anthropicClient.js";
import { appendMessages, createSideChat, getSideChat, removeSideChat } from "../lib/store.js";

export const sideChatsRouter = Router();

sideChatsRouter.post("/", async (req, res) => {
  const { parentUserMessage, parentAiResponse, selectedText, priorContext, question } = req.body ?? {};

  // parentUserMessage may legitimately be "" — the extension sends that
  // whenever the DOM has no preceding user turn to find, which happens for
  // the first message in a conversation and (on sites like ChatGPT that
  // virtualize long threads) for any turn whose preceding user message has
  // been unmounted from the DOM after scrolling. Only its type is required,
  // not that it's non-empty.
  if (
    typeof parentUserMessage !== "string" ||
    !parentAiResponse ||
    !selectedText ||
    !question
  ) {
    res.status(400).json({
      error: "parentUserMessage (string), parentAiResponse, selectedText, and question are required",
    });
    return;
  }

  const sideChat = createSideChat({ parentUserMessage, parentAiResponse, selectedText, priorContext });

  try {
    const reply = await askSideChat(sideChat, question);
    appendMessages(sideChat.id, [
      { role: "user", content: question },
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
  if (!question) {
    res.status(400).json({ error: "question is required" });
    return;
  }

  try {
    const reply = await askSideChat(sideChat, question);
    appendMessages(sideChat.id, [
      { role: "user", content: question },
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
