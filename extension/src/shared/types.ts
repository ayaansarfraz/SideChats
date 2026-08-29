export type Role = "user" | "assistant";

export type ChatMessage = {
  role: Role;
  content: string;
};

/** Everything extracted from the page needed to start (or continue) a side chat. */
export type ContextPackage = {
  selectedText: string;
  parentUserMessage: string;
  parentAiResponse: string;
  priorContext?: string;
};

export type SideChatStatus = "idle" | "loading" | "error";

/** Client-side state for the currently open side chat panel. */
export type SideChatState = {
  sideChatId: string | null;
  contextPackage: ContextPackage;
  messages: ChatMessage[];
  status: SideChatStatus;
  error?: string;
};
