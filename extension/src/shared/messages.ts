import type { ContextPackage } from "./types";

/** Messages the content script sends to the background service worker. */
export type CreateSideChatRequest = {
  type: "CREATE_SIDE_CHAT";
  payload: ContextPackage & { question: string };
};

export type SendMessageRequest = {
  type: "SEND_MESSAGE";
  payload: { sideChatId: string; question: string };
};

export type ExtensionRequest = CreateSideChatRequest | SendMessageRequest;

export type ExtensionResponse =
  | { ok: true; sideChatId: string; reply: string }
  | { ok: false; error: string; errorType: "network" | "http" };
