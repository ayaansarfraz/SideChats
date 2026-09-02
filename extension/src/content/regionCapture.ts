/**
 * Drag-a-region-and-ask.
 *
 * The content script cannot photograph the tab itself — `captureVisibleTab` is
 * a `chrome.tabs` API and only the service worker can call it. So this half
 * does the part that needs a page: put an overlay up, let the user draw a box,
 * and hand the worker a rectangle. The worker sends back a cropped
 * `ImageAttachment` and this module pairs it with whatever conversation turn
 * the box landed on.
 *
 * The one non-obvious ordering constraint is in `capture()`: the overlay and
 * the panel are part of the visible tab, so they have to be gone *and painted
 * as gone* before the worker is asked for a screenshot, or the panel ends up
 * inside its own picture.
 */
import type { CaptureRegionRequest, ExtensionResponse } from "../shared/messages";
import type { ContextPackage, ImageAttachment, Rect } from "../shared/types";
import { MIN_CAPTURE_EDGE } from "../shared/image";
import { elementUnderRegion, getRegionContext } from "./context";
import {
  ExtensionContextInvalidatedError,
  EXTENSION_RELOADED_MESSAGE,
  isContextInvalidatedError,
  isExtensionAlive,
} from "./runtime";

const HOST_ID = "sidechats-capture-root";

/**
 * The floating Ask button lives in the light DOM, outside the panel's shadow
 * host, so `hideForCapture()` does not cover it (panel.ts says as much) and it
 * would otherwise be photographed sitting over the region.
 */
const ASK_BUTTON_ID = "sidechats-ask-button";

/** Highest usable z-index — the overlay must sit above the panel and the page. */
const OVERLAY_Z_INDEX = "2147483647";

/**
 * What the panel needs to do for a capture to come out clean. `PanelController`
 * is structurally assignable to this, so the integrator passes the panel
 * straight through.
 *
 * These are **required**, not optional, on purpose: a capture with the panel
 * left showing is the single failure this feature is most likely to ship with,
 * and it produces a plausible-looking image rather than an error. Making the
 * dependency part of the signature turns that into a compile error instead.
 */
export type RegionCaptureDeps = {
  hideForCapture: () => void;
  showAfterCapture: () => void;
  /**
   * Surface a capture failure to the user. Optional only because a caller
   * without an error surface is better served by a console warning than by
   * being unable to call this at all.
   */
  onError?: (message: string) => void;
};

export type RegionCaptureController = {
  /** Put the overlay up. A no-op while a capture is already in flight. */
  start: () => void;
  /** Tear the overlay down without capturing. Safe to call when inactive. */
  cancel: () => void;
  isActive: () => boolean;
};

const OVERLAY_CSS = `
:host { all: initial; }
.backdrop {
  position: absolute;
  inset: 0;
  background: rgba(15, 17, 21, 0.32);
  transition: background 80ms linear;
}
/* While dragging, the selection's own ring-shaped shadow does the dimming, so
   the backdrop steps aside — that is what leaves the chosen region bright. */
.backdrop.dragging { background: transparent; }
.rect {
  position: absolute;
  display: none;
  border: 1px solid rgba(255, 255, 255, 0.95);
  box-shadow: 0 0 0 100vmax rgba(15, 17, 21, 0.32), 0 0 0 1px rgba(15, 17, 21, 0.55) inset;
  box-sizing: border-box;
}
.rect.visible { display: block; }
.hint {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 12px;
  border-radius: 999px;
  background: rgba(15, 17, 21, 0.88);
  color: #fff;
  font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  letter-spacing: 0.01em;
  white-space: nowrap;
  pointer-events: none;
}
.hint.dragging { opacity: 0; }
`;

/**
 * Wait for a paint, but never longer than this. `requestAnimationFrame` does
 * not fire in a backgrounded tab, and a capture that hangs forever would leave
 * the panel hidden with no way back — a timeout that occasionally captures one
 * frame early is the better failure.
 */
const PAINT_TIMEOUT_MS = 100;

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(() => done());
    setTimeout(done, PAINT_TIMEOUT_MS);
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Normalise a drag into a viewport rectangle: positive width and height
 * whichever way it was drawn, clamped to the viewport because the pointer can
 * be dragged past the edge of the window.
 */
function rectFromDrag(
  origin: { x: number; y: number },
  current: { x: number; y: number },
  viewport: { width: number; height: number },
): Rect {
  const x1 = clamp(origin.x, 0, viewport.width);
  const y1 = clamp(origin.y, 0, viewport.height);
  const x2 = clamp(current.x, 0, viewport.width);
  const y2 = clamp(current.y, 0, viewport.height);

  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** Exported for tests — the drag maths is the part worth pinning down. */
export { rectFromDrag };

/** A drag this small is a click that landed on the overlay, not a region. */
function isCapturable(rect: Rect): boolean {
  return rect.width >= MIN_CAPTURE_EDGE && rect.height >= MIN_CAPTURE_EDGE;
}

async function requestCapture(rect: Rect): Promise<ExtensionResponse> {
  // Checked up front so a dead context reads as one clear condition rather
  // than whatever error the send happens to throw on the way out — the same
  // shape apiClient.ts uses for the other direction.
  if (!isExtensionAlive()) throw new ExtensionContextInvalidatedError();

  const request: CaptureRegionRequest = {
    type: "CAPTURE_REGION",
    payload: { rect, devicePixelRatio: window.devicePixelRatio || 1 },
  };

  let response: ExtensionResponse | undefined;
  try {
    response = (await chrome.runtime.sendMessage(request)) as ExtensionResponse | undefined;
  } catch (err) {
    if (isContextInvalidatedError(err) || !isExtensionAlive()) {
      throw new ExtensionContextInvalidatedError();
    }
    throw err;
  }

  // sendMessage resolves undefined when nothing answered — the worker died
  // mid-flight, or was replaced between the liveness check and the send.
  if (!response) throw new ExtensionContextInvalidatedError();

  return response;
}

export function initRegionCapture(
  onCaptured: (image: ImageAttachment, context: ContextPackage) => void,
  panel: RegionCaptureDeps,
): RegionCaptureController {
  let host: HTMLDivElement | null = null;
  let backdropEl: HTMLDivElement | null = null;
  let rectEl: HTMLDivElement | null = null;
  let hintEl: HTMLDivElement | null = null;

  let dragging = false;
  let origin = { x: 0, y: 0 };
  // Set while the worker is being asked for a screenshot, so a second toolbar
  // click during that window doesn't put a fresh overlay into the picture.
  let capturing = false;

  const reportError = (message: string): void => {
    if (panel.onError) panel.onError(message);
    else console.warn("[SideChats]", message);
  };

  function viewport(): { width: number; height: number } {
    return {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: document.documentElement.clientHeight || window.innerHeight,
    };
  }

  function drawRect(rect: Rect): void {
    if (!rectEl) return;
    rectEl.style.left = `${rect.x}px`;
    rectEl.style.top = `${rect.y}px`;
    rectEl.style.width = `${rect.width}px`;
    rectEl.style.height = `${rect.height}px`;
    rectEl.classList.add("visible");
  }

  function setDragging(on: boolean): void {
    dragging = on;
    backdropEl?.classList.toggle("dragging", on);
    hintEl?.classList.toggle("dragging", on);
  }

  function onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    // Suppresses the text selection the drag would otherwise make on the page
    // underneath, which would then race the Ask button into view.
    event.preventDefault();
    event.stopPropagation();
    origin = { x: event.clientX, y: event.clientY };
    setDragging(true);
    drawRect(rectFromDrag(origin, origin, viewport()));
  }

  function onMouseMove(event: MouseEvent): void {
    if (!dragging) return;
    drawRect(rectFromDrag(origin, { x: event.clientX, y: event.clientY }, viewport()));
  }

  function onMouseUp(event: MouseEvent): void {
    if (!dragging) return;
    setDragging(false);
    const rect = rectFromDrag(origin, { x: event.clientX, y: event.clientY }, viewport());
    if (!isCapturable(rect)) {
      // A stray click on the overlay reads as "never mind", not as an error.
      teardown();
      return;
    }
    void capture(rect);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    teardown();
  }

  /**
   * Scrolling mid-drag would move the page under a rectangle that is expressed
   * in viewport coordinates, so the box would no longer frame what the user
   * drew it around. Blocking the scroll is less surprising than silently
   * capturing something else.
   */
  function onWheel(event: WheelEvent): void {
    event.preventDefault();
  }

  /** A resize invalidates the drag in progress outright. */
  function onResize(): void {
    teardown();
  }

  function mount(): void {
    host = document.createElement("div");
    host.id = HOST_ID;
    // Appended to documentElement rather than body: a `transform` on <body>
    // (common enough on chat sites with slide-in sidebars) would make
    // `position: fixed` resolve against that element instead of the viewport,
    // and the overlay would no longer line up with the coordinates it reports.
    host.style.cssText = [
      "position:fixed",
      "inset:0",
      "margin:0",
      "padding:0",
      "border:0",
      "cursor:crosshair",
      `z-index:${OVERLAY_Z_INDEX}`,
    ].join(";");

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = OVERLAY_CSS;

    backdropEl = document.createElement("div");
    backdropEl.className = "backdrop";

    rectEl = document.createElement("div");
    rectEl.className = "rect";

    hintEl = document.createElement("div");
    hintEl.className = "hint";
    hintEl.textContent = "Drag to capture a region · Esc to cancel";

    shadow.append(style, backdropEl, rectEl, hintEl);
    document.documentElement.appendChild(host);

    host.addEventListener("mousedown", onMouseDown, true);
    // Move and up go on the window: a drag that leaves the viewport still has
    // to keep tracking, and the mouseup can land outside the overlay.
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    window.addEventListener("resize", onResize, true);
  }

  function teardown(): void {
    if (!host) return;
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("wheel", onWheel, true);
    window.removeEventListener("resize", onResize, true);
    host.remove();
    host = null;
    backdropEl = null;
    rectEl = null;
    hintEl = null;
    dragging = false;
  }

  async function capture(rect: Rect): Promise<void> {
    // Order matters: everything of ours that is on screen goes away first, and
    // only then does the worker photograph the tab.
    teardown();
    capturing = true;

    const askButton = document.getElementById(ASK_BUTTON_ID);
    const askVisibility = askButton?.style.visibility;
    if (askButton) askButton.style.visibility = "hidden";
    panel.hideForCapture();

    let target: Element | null = null;
    try {
      // Two frames, not one: the first schedules the paint that removes our
      // UI, the second lands after it. One frame captures the panel.
      await nextPaint();
      await nextPaint();

      // Resolved while everything of ours is hidden, so elementFromPoint
      // reports the page rather than our own overlay or panel.
      target = elementUnderRegion(rect);

      const response = await requestCapture(rect);
      if (!response.ok) {
        reportError(response.error);
        return;
      }
      if (response.kind !== "image") {
        reportError("Expected a captured image from the extension, got a reply.");
        return;
      }

      onCaptured(response.image, getRegionContext(response.image, target));
    } catch (err) {
      reportError(
        isContextInvalidatedError(err)
          ? EXTENSION_RELOADED_MESSAGE
          : err instanceof Error
            ? err.message
            : "Couldn't capture that region.",
      );
    } finally {
      panel.showAfterCapture();
      if (askButton) askButton.style.visibility = askVisibility ?? "";
      capturing = false;
    }
  }

  return {
    start(): void {
      if (host || capturing) return;
      if (!isExtensionAlive()) {
        reportError(EXTENSION_RELOADED_MESSAGE);
        return;
      }
      mount();
    },
    cancel(): void {
      teardown();
    },
    isActive(): boolean {
      return host !== null || capturing;
    },
  };
}
