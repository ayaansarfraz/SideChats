export type Role = "user" | "assistant";

/**
 * The subset of image formats the Anthropic Messages API accepts. Anything the
 * user hands us outside this list is rejected at the point of capture rather
 * than being discovered by the server or, worse, the model.
 */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/**
 * An image on its way to (or already attached to) a side chat message.
 *
 * `data` is bare base64 with no `data:...;base64,` prefix — the API wants the
 * payload alone, and carrying the prefix around means every consumer has to
 * remember to strip it. The panel adds it back when building an `<img src>`.
 */
export type ImageAttachment = {
  /** Stable key for tray chips and rendered thumbnails. */
  id: string;
  mediaType: ImageMediaType;
  data: string;
  width: number;
  height: number;
  /** Decoded byte length, so size caps don't have to re-derive it from base64. */
  byteSize: number;
};

export type ChatMessage = {
  role: Role;
  content: string;
  images?: ImageAttachment[];
};

/** Everything extracted from the page needed to start (or continue) a side chat. */
export type ContextPackage = {
  selectedText: string;
  parentUserMessage: string;
  parentAiResponse: string;
  priorContext?: string;
  /**
   * Set when the side chat is branching off a captured region of the page
   * rather than (or as well as) a text selection. When this is present
   * `selectedText` may legitimately be empty — the picture is the excerpt.
   */
  screenshot?: ImageAttachment;
};

export type SideChatStatus = "idle" | "loading" | "error";

/** Client-side state for the currently open side chat panel. */
export type SideChatState = {
  sideChatId: string | null;
  contextPackage: ContextPackage;
  messages: ChatMessage[];
  status: SideChatStatus;
  error?: string;
  /** Images staged in the composer, not yet sent. Cleared on submit. */
  pendingImages: ImageAttachment[];
};

/** CSS-pixel rectangle in viewport coordinates. */
export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};
