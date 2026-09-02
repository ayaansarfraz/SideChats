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
  const missing: string[] = [];
  if (typeof parentUserMessage !== "string") missing.push("parentUserMessage");
  if (!parentAiResponse) missing.push("parentAiResponse");
  if (!selectedText) missing.push("selectedText");
  if (!question) missing.push("question");

  if (missing.length > 0) {
    // Name the fields that actually failed — a blanket "these four are
    // required" says nothing about which one the page failed to extract,
    // which is exactly what you need to know when a site's DOM changes.
    console.error("[SideChats] rejected create, missing/invalid fields:", missing.join(", "));
    res.status(400).json({ error: `Missing or empty: ${missing.join(", ")}` });
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
