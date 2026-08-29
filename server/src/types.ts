export type Message = {
  role: "user" | "assistant";
  content: string;
};

export type SideChat = {
  id: string;
  createdAt: number;
  lastActiveAt: number;
  parentUserMessage: string;
  parentAiResponse: string;
  selectedText: string;
  priorContext?: string;
  messages: Message[];
};
