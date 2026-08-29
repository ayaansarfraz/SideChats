export type ContextPackageInput = {
  parentUserMessage: string;
  parentAiResponse: string;
  selectedText: string;
  priorContext?: string;
};

export function buildSystemPrompt({
  parentUserMessage,
  parentAiResponse,
  selectedText,
  priorContext,
}: ContextPackageInput): string {
  const sections = [
    "You are answering a clarification about an existing AI conversation.",
    "The user has highlighted a piece of text from an AI response and wants to ask follow-up questions about it. Answer specifically in the context of the parent conversation below, not as a generic definition.",
    "",
    "PARENT USER MESSAGE:",
    parentUserMessage,
    "",
    "PARENT AI RESPONSE:",
    parentAiResponse,
    "",
    "SELECTED TEXT:",
    selectedText,
  ];

  if (priorContext) {
    sections.push("", "OPTIONAL RELEVANT PRIOR CONTEXT:", priorContext);
  }

  return sections.join("\n");
}
