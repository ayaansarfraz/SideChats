import Anthropic from "@anthropic-ai/sdk";
import type { SideChat } from "../types.js";
import { buildSystemPrompt } from "./contextPackage.js";

const anthropic = new Anthropic();
const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

export async function askSideChat(sideChat: SideChat, question: string): Promise<string> {
  const system = buildSystemPrompt({
    parentUserMessage: sideChat.parentUserMessage,
    parentAiResponse: sideChat.parentAiResponse,
    selectedText: sideChat.selectedText,
    priorContext: sideChat.priorContext,
  });

  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    system,
    messages: [
      ...sideChat.messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: question },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Anthropic response contained no text content");
  }
  return textBlock.text;
}
