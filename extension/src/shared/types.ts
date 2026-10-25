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

/**
 * A side chat as it is written to `chrome.storage.local`, so that dismissing the
 * panel — or reloading the page under it — stops being the same thing as
 * throwing the conversation away.
 *
 * Deliberately not a `SideChatState`: `status` and `error` describe an in-flight
 * request that cannot survive a reload anyway, and `pendingImages` are staged
 * but unsent, which makes them both the largest thing in state and the least
 * worth keeping.
 */
export type PersistedChatMessage = ChatMessage & {
  /**
   * Set when the images on this message were dropped to fit the storage quota,
   * so the restored bubble can say so instead of silently losing a picture the
   * user remembers attaching.
   */
  imagesDropped?: boolean;
};

export type PersistedSideChat = {
  sideChatId: string | null;
  contextPackage: ContextPackage;
  messages: PersistedChatMessage[];
  /** Whether the panel was on screen when this was written. */
  isOpen: boolean;
  /**
   * When this was last written, ms since epoch. Also how a restore can tell
   * that the server's 30-minute idle sweep has almost certainly taken the
   * `sideChatId` with it.
   */
  savedAt: number;
};
