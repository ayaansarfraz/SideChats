import type { ContextPackage } from "../shared/types";

const BUTTON_ID = "sidechats-ask-button";
const BUTTON_OFFSET_PX = 8;

export function initAskButton(
  getContext: (selection: Selection) => ContextPackage | null,
  onAsk: (ctx: ContextPackage) => void,
): void {
  let button: HTMLButtonElement | null = null;
  let currentCtx: ContextPackage | null = null;

  function removeButton(): void {
    button?.remove();
    button = null;
    currentCtx = null;
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

  function showButton(rect: DOMRect, ctx: ContextPackage): void {
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
    el.style.background = "#10a37f";
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
      removeButton();
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      removeButton();
      return;
    }

    showButton(rect, ctx);
  }

  document.addEventListener("mouseup", handleSelectionEnd);
  document.addEventListener("scroll", removeButton, true);
  document.addEventListener("selectionchange", () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      removeButton();
    }
  });
}
