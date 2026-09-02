import { randomUUID } from "node:crypto";
import type { Message, SideChat, StoredImage } from "../types.js";

const IDLE_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const sideChats = new Map<string, SideChat>();

export function createSideChat(input: {
  parentUserMessage: string;
  parentAiResponse: string;
  selectedText: string;
  priorContext?: string;
  screenshot?: StoredImage;
}): SideChat {
  const now = Date.now();
  const sideChat: SideChat = {
    id: randomUUID(),
    createdAt: now,
    lastActiveAt: now,
    parentUserMessage: input.parentUserMessage,
    parentAiResponse: input.parentAiResponse,
    selectedText: input.selectedText,
    priorContext: input.priorContext,
    screenshot: input.screenshot,
    messages: [],
  };
  sideChats.set(sideChat.id, sideChat);
  return sideChat;
}

export function getSideChat(id: string): SideChat | undefined {
  return sideChats.get(id);
}

export function appendMessages(id: string, messages: Message[]): SideChat | undefined {
  const sideChat = sideChats.get(id);
  if (!sideChat) return undefined;
  sideChat.messages.push(...messages);
  sideChat.lastActiveAt = Date.now();
  return sideChat;
}

export function removeSideChat(id: string): boolean {
  return sideChats.delete(id);
}

export function sweepIdleSideChats() {
  const cutoff = Date.now() - IDLE_TTL_MS;
  for (const [id, sideChat] of sideChats) {
    if (sideChat.lastActiveAt < cutoff) {
      sideChats.delete(id);
    }
  }
}

setInterval(sweepIdleSideChats, SWEEP_INTERVAL_MS).unref();
