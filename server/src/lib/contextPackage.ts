export type ContextPackageInput = {
  parentUserMessage: string;
  parentAiResponse: string;
  selectedText: string;
  priorContext?: string;
  /**
   * True when the side chat branched off a captured region rather than a text
   * selection. The system prompt is a plain string and cannot itself carry an
   * image — the bytes ride on the first user turn — so all this can do is tell
   * the model where to look.
   */
  hasScreenshot?: boolean;
};

export function buildSystemPrompt({
  parentUserMessage,
  parentAiResponse,
  selectedText,
  priorContext,
  hasScreenshot,
}: ContextPackageInput): string {
  // A region can be dragged over a chart or a diagram with no text selected at
  // all, so "highlighted a piece of text" would be a flat lie in that case.
  const branchedOffRegion = hasScreenshot === true && !selectedText;

  const sections = [
    "You are answering a clarification about an existing AI conversation.",
    branchedOffRegion
      ? "The user has captured a region of the page as an image and wants to ask follow-up questions about it. Answer specifically in the context of the parent conversation below, not as a generic description of the picture."
      : "The user has highlighted a piece of text from an AI response and wants to ask follow-up questions about it. Answer specifically in the context of the parent conversation below, not as a generic definition.",
    "",
    "PARENT USER MESSAGE:",
    parentUserMessage,
    "",
    "PARENT AI RESPONSE:",
    parentAiResponse,
    "",
  ];

  if (branchedOffRegion) {
    sections.push(
      "SELECTED REGION:",
      "The user did not highlight text. They dragged a region of the page and captured it as an image, which is attached to their first message below. Treat that image as the thing they are asking about.",
    );
  } else {
    sections.push("SELECTED TEXT:", selectedText);
  }

  if (priorContext) {
    sections.push("", "OPTIONAL RELEVANT PRIOR CONTEXT:", priorContext);
  }

  return sections.join("\n");
}
