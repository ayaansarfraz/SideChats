import type { ContextPackage } from "../shared/types";

const BUTTON_ID = "sidechats-ask-button";
const BUTTON_OFFSET_PX = 8;
const DEFAULT_ACCENT = "#10a37f";

export type AskButtonOptions = {
  /** Button colour, so it reads as native on whichever site it appears. */
  accentColor?: string;
};

export function initAskButton(
  getContext: (selection: Selection) => ContextPackage | null,
  onAsk: (ctx: ContextPackage) => void,
  options: AskButtonOptions = {},
): void {
  const accentColor = options.accentColor ?? DEFAULT_ACCENT;
  let button: HTMLButtonElement | null = null;
  let currentCtx: ContextPackage | null = null;
  let currentRange: Range | null = null;
  let shownAt = 0;

  function removeButton(reason?: string): void {
    // A button that vanishes within a moment of appearing looks, to the user,
    // exactly like one that never appeared. Say what took it away.
    if (button && reason && Date.now() - shownAt < 1000) {
      debug(`Ask button removed ${Date.now() - shownAt}ms after showing: ${reason}`);
    }
    button?.remove();
    button = null;
    currentCtx = null;
    currentRange = null;
  }

  /**
   * Keep the button attached to the selection when something scrolls.
   *
   * Removing it on every scroll was too eager: chat sites scroll inner
   * containers on their own (streaming, layout shifts, anchoring), and any of
   * those killed the button the instant it appeared. Only a selection that has
   * scrolled out of view loses it.
   */
  function followScroll(): void {
    if (!button || !currentRange) return;
    const rect = currentRange.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    if ((rect.width === 0 && rect.height === 0) || rect.bottom < 0 || rect.top > viewportHeight) {
      removeButton("selection scrolled out of view");
      return;
    }
    positionButton(button, rect);
  }

  function positionButton(el: HTMLButtonElement, rect: DOMRect): void {
    // Default: just below the end of the selection, right-aligned to it.
    const buttonWidth = el.offsetWidth || 60;
    const buttonHeight = el.offsetHeight || 28;

    let top = rect.bottom + BUTTON_OFFSET_PX;
    let left = rect.right - buttonWidth;

    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;

    // Flip above the selection if there's no room below.
    if (top + buttonHeight > viewportHeight) {
      top = rect.top - buttonHeight - BUTTON_OFFSET_PX;
    }
    // Clamp horizontally so it never renders off-screen.
    left = Math.max(BUTTON_OFFSET_PX, Math.min(left, viewportWidth - buttonWidth - BUTTON_OFFSET_PX));
    // Clamp vertically as a last resort (very short viewport / huge selection).
    top = Math.max(BUTTON_OFFSET_PX, Math.min(top, viewportHeight - buttonHeight - BUTTON_OFFSET_PX));

    el.style.top = `${top + window.scrollY}px`;
    el.style.left = `${left + window.scrollX}px`;
  }

  function showButton(rect: DOMRect, ctx: ContextPackage, range: Range): void {
    removeButton();

    const el = document.createElement("button");
    el.id = BUTTON_ID;
    el.type = "button";
    el.textContent = "Ask";
    el.style.position = "absolute";
    el.style.zIndex = "2147483647";
    el.style.padding = "4px 10px";
    el.style.borderRadius = "6px";
    el.style.border = "none";
    el.style.background = accentColor;
    el.style.color = "#fff";
    el.style.font = "600 13px/1.2 system-ui, sans-serif";
    el.style.cursor = "pointer";
    el.style.boxShadow = "0 2px 8px rgba(0,0,0,0.2)";

    // Prevent the mousedown from collapsing the selection before click fires.
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const askedCtx = currentCtx;
      removeButton();
      if (askedCtx) onAsk(askedCtx);
    });

    document.body.appendChild(el);
    positionButton(el, rect);

    button = el;
    currentCtx = ctx;
    currentRange = range;
    shownAt = Date.now();
  }

  function handleSelectionEnd(e: Event): void {
    // Ignore mouseup on the button itself (click handler owns that).
    if (button && e.target instanceof Node && button.contains(e.target)) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      removeButton();
      return;
    }

    const ctx = getContext(selection);
    if (!ctx) {
      debug("no Ask button: selection is not inside an AI reply.", describeAncestors(selection.anchorNode));
      removeButton();
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      debug("no Ask button: the selection has no on-screen box.");
      removeButton();
      return;
    }

    showButton(rect, ctx, range);
  }

  // Capture phase on window, so the host page can't swallow the event first.
  // A bubbling listener on document misses any mouseup the page stops on the
  // way up — e.g. a site handling selection for its own popup — and the button
  // then silently never appears.
  window.addEventListener("mouseup", handleSelectionEnd, true);
  document.addEventListener("scroll", followScroll, true);
  document.addEventListener("selectionchange", () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      removeButton("the page cleared the selection");
    }
  });
}

function debug(...args: unknown[]): void {
  console.info("[SideChats]", ...args);
}

/**
 * The selection's ancestors that carry identifying attributes — what a site
 * adapter's selectors would have to match. Logged when a selection is
 * rejected, so a site whose markup has moved can be fixed from one console
 * line instead of a guess.
 */
function describeAncestors(node: Node | null): string[] {
  const out: string[] = [];
  let el = node && (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement);
  for (let depth = 0; el && depth < 15; el = el.parentElement, depth++) {
    const attrs = Array.from(el.attributes)
      .filter((a) => a.name.startsWith("data-") || a.name === "role")
      .map((a) => `${a.name}="${a.value.slice(0, 40)}"`);
    if (attrs.length) out.push(`${el.tagName.toLowerCase()} ${attrs.join(" ")}`);
  }
  return out;
}
