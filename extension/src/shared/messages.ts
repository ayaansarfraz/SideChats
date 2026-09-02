import type { ContextPackage, ImageAttachment, Rect } from "./types";

/** Messages the content script sends to the background service worker. */
export type CreateSideChatRequest = {
  type: "CREATE_SIDE_CHAT";
  payload: ContextPackage & { question: string; images?: ImageAttachment[] };
};

export type SendMessageRequest = {
  type: "SEND_MESSAGE";
  payload: { sideChatId: string; question: string; images?: ImageAttachment[] };
};

/**
 * Crop a region out of the visible tab. The content script can't call
 * `chrome.tabs.captureVisibleTab` itself, so it hands the worker a rectangle in
 * CSS pixels plus the page's `devicePixelRatio` — the capture comes back at
 * device resolution and the rect has to be scaled to match before cropping.
 */
export type CaptureRegionRequest = {
  type: "CAPTURE_REGION";
  payload: { rect: Rect; devicePixelRatio: number };
};

export type ExtensionRequest =
  | CreateSideChatRequest
  | SendMessageRequest
  | CaptureRegionRequest;

/**
 * Messages the background service worker sends *to* a content script — the
 * opposite direction from `ExtensionRequest`. Toolbar clicks arrive at the
 * worker, so starting a region capture has to be relayed into the page.
 */
export type StartRegionCaptureMessage = { type: "START_REGION_CAPTURE" };

export type BackgroundMessage = StartRegionCaptureMessage;

/**
 * `kind` discriminates the success arms. Without it a caller can only tell a
 * reply from an image by probing for fields, which is exactly the kind of
 * narrowing that compiles today and breaks silently when a third arm lands.
 */
export type ReplyResponse = {
  ok: true;
  kind: "reply";
  sideChatId: string;
  reply: string;
};

export type ImageResponse = {
  ok: true;
  kind: "image";
  image: ImageAttachment;
};

export type ErrorResponse = {
  ok: false;
  error: string;
  errorType: "network" | "http";
};

export type ExtensionResponse = ReplyResponse | ImageResponse | ErrorResponse;
