/**
 * Mirrors `ImageAttachment` in the extension, minus `byteSize` — that field
 * exists to enforce the client-side cap and carries no meaning once the bytes
 * are here. These two files are not compiled together, so the wire format is
 * written down in BUILD_PLAN.md; changing one without the other is the failure
 * mode to watch for.
 */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type StoredImage = {
  id: string;
  mediaType: ImageMediaType;
  /** Bare base64, no `data:` prefix — what the Anthropic API takes directly. */
  data: string;
  width: number;
  height: number;
};

export type Message = {
  role: "user" | "assistant";
  content: string;
  images?: StoredImage[];
};

export type SideChat = {
  id: string;
  createdAt: number;
  lastActiveAt: number;
  parentUserMessage: string;
  parentAiResponse: string;
  selectedText: string;
  priorContext?: string;
  /**
   * The captured region this side chat branched off, when it branched off a
   * picture rather than a text selection. Stored once here rather than being
   * duplicated into the first message; `selectedText` may be empty when this
   * is set.
   */
  screenshot?: StoredImage;
  messages: Message[];
};
