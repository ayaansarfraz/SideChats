import type { ContextPackage, ImageAttachment, Rect, Role } from "../shared/types";
import { getAdapterForHost, type SiteAdapter } from "./adapters";

/**
 * Every conversation turn on the page, outermost-first, in document order.
 *
 * An adapter may list several selectors that match the same turn (a wrapper and
 * the element it wraps). Keeping only elements that no other match contains
 * collapses each of those groups to one entry, so a turn is never counted twice
 * and the returned turns are disjoint.
 */
export function collectTurns(adapter: SiteAdapter, root: ParentNode): Element[] {
  const matches = Array.from(root.querySelectorAll<Element>(adapter.turnSelector));
  return matches.filter(
    (el) => adapter.roleOf(el) !== null && !matches.some((other) => other !== el && other.contains(el)),
  );
}

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/**
 * The turn containing `node`, or `null` if it sits outside the conversation.
 *
 * Falls back to walking up from the node when no collected turn contains it,
 * which covers a turn that has been detached from the document between the
 * selection and the click — a React re-render mid-stream does exactly that.
 * Such a turn has no position among the others, so the caller finds no
 * neighbours for it and the context package comes back with just the response.
 */
function turnContaining(
  adapter: SiteAdapter,
  turns: Element[],
  node: Node | null,
): Element | null {
  const el = elementOf(node);
  if (!el) return null;
  const attached = turns.find((turn) => turn.contains(el));
  if (attached) return attached;

  const detached = el.closest(adapter.turnSelector);
  return detached && adapter.roleOf(detached) !== null ? detached : null;
}

/**
 * Which turn a selection belongs to.
 *
 * The anchor — where the drag started — decides, so a selection that begins in
 * the user's own message is still not askable even if it runs on into the
 * reply. `focusNode` is only a fallback for when the anchor lands outside every
 * turn, which happens when the drag starts in the page margin or the gap
 * between turns and ends inside an answer; anchor-only extraction dropped those
 * selections on the floor.
 */
function resolveTurn(
  adapter: SiteAdapter,
  turns: Element[],
  selection: Selection,
): Element | null {
  for (const candidate of [selection.anchorNode, selection.focusNode]) {
    const turn = turnContaining(adapter, turns, candidate);
    if (turn) return turn;
  }
  return null;
}

/** Walk backwards from `fromIndex` for the nearest turn with the given role. */
function previousTurnOfRole(
  adapter: SiteAdapter,
  turns: Element[],
  fromIndex: number,
  role: Role,
): Element | null {
  for (let i = fromIndex - 1; i >= 0; i--) {
    if (adapter.roleOf(turns[i]) === role) return turns[i];
  }
  return null;
}

function rawText(el: Element): string {
  // Falls back on an *empty* innerText, not just a missing one: innerText is
  // rendered text, so anything unrendered (or not laid out yet) yields "",
  // and losing the message entirely is far worse than losing line breaks.
  const rendered = (el as HTMLElement).innerText?.trim();
  if (rendered) return rendered;
  return el.textContent?.trim() ?? "";
}

/**
 * The turn's text with UI chrome stripped.
 *
 * `innerText` needs layout, so a detached clone would silently degrade to
 * `textContent` and lose every line break. The stripped copy is measured in an
 * off-screen host attached to the same document instead — same stylesheets,
 * same line breaking, and the live turn is never mutated.
 *
 * The host must stay *rendered* to be measurable: `innerText` collects rendered
 * text, and `visibility: hidden` (like `display: none`) renders no text at all,
 * so measuring inside one returns "" and silently empties the message. Moving
 * it off-screen hides it from the user while keeping it laid out; it is
 * appended and removed within one synchronous task, so it is never painted.
 */
function textWithoutNoise(el: Element, noiseSelector: string): string {
  const doc = el.ownerDocument;
  const body = doc?.body;
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll(noiseSelector).forEach((n) => n.remove());
  if (!body) return rawText(clone);

  const host = doc.createElement("div");
  host.style.cssText =
    "position:absolute;left:-9999px;top:0;width:800px;pointer-events:none;";
  host.appendChild(clone);
  try {
    body.appendChild(host);
    return rawText(clone);
  } finally {
    host.remove();
  }
}

function turnText(adapter: SiteAdapter, el: Element): string {
  const noise = adapter.noiseSelectors?.join(",");
  // Only pay for the off-screen clone when there is actually chrome to strip.
  if (noise && el.querySelector(noise)) return textWithoutNoise(el, noise);
  return rawText(el);
}

/**
 * The conversation around an assistant turn: the message that prompted it and,
 * where there is one, the exchange before that.
 *
 * Shared by the two ways into a side chat — a text selection and a captured
 * region — so the surrounding context a branch carries doesn't depend on which
 * gesture started it.
 */
function surroundingsOf(
  adapter: SiteAdapter,
  turns: Element[],
  assistantTurn: Element,
): Pick<ContextPackage, "parentUserMessage" | "parentAiResponse" | "priorContext"> {
  const assistantIndex = turns.indexOf(assistantTurn);
  const parentAiResponse = turnText(adapter, assistantTurn);

  const userTurn = previousTurnOfRole(adapter, turns, assistantIndex, "user");
  const parentUserMessage = userTurn ? turnText(adapter, userTurn) : "";

  let priorContext: string | undefined;
  if (userTurn) {
    const priorAssistantTurn = previousTurnOfRole(
      adapter,
      turns,
      turns.indexOf(userTurn),
      "assistant",
    );
    if (priorAssistantTurn) {
      const priorUserTurn = previousTurnOfRole(
        adapter,
        turns,
        turns.indexOf(priorAssistantTurn),
        "user",
      );
      const parts: string[] = [];
      if (priorUserTurn) parts.push(`User: ${turnText(adapter, priorUserTurn)}`);
      parts.push(`Assistant: ${turnText(adapter, priorAssistantTurn)}`);
      priorContext = parts.join("\n\n");
    }
  }

  return {
    parentUserMessage,
    parentAiResponse,
    ...(priorContext ? { priorContext } : {}),
  };
}

/**
 * Build the context package for a selection, using `adapter` to interpret the
 * page. Exported separately from `getSelectionContext` so tests can drive it
 * against a fixture document without stubbing `window.location`.
 */
export function extractContext(
  selection: Selection,
  adapter: SiteAdapter,
  root: ParentNode,
): ContextPackage | null {
  if (!selection || selection.rangeCount === 0) return null;

  const selectedText = selection.toString();
  if (!selectedText.trim()) return null;

  const turns = collectTurns(adapter, root);
  const turn = resolveTurn(adapter, turns, selection);
  // Side chats branch off what the AI said, so a selection in the user's own
  // message (or in page furniture outside the conversation) is not askable.
  if (!turn || adapter.roleOf(turn) !== "assistant") return null;

  return { selectedText, ...surroundingsOf(adapter, turns, turn) };
}

/**
 * Build the context package for a captured region.
 *
 * The picture is the excerpt, so `selectedText` is empty and `screenshot`
 * carries the branch point. Unlike a selection this never returns `null`: the
 * user has already dragged a box and waited for a capture, and throwing that
 * away because the box happened to land in the page margin would be a worse
 * answer than a side chat with no surrounding turn.
 *
 * Where the region *does* land decides how much conversation rides along:
 * inside an assistant turn it gets the same surroundings a selection would;
 * inside the user's own message it gets that message and no response (there is
 * nothing to branch off yet); outside the conversation entirely, both are empty
 * and the image stands alone.
 */
export function extractRegionContext(
  element: Element | null,
  screenshot: ImageAttachment,
  adapter: SiteAdapter,
  root: ParentNode,
): ContextPackage {
  const base: ContextPackage = {
    selectedText: "",
    parentUserMessage: "",
    parentAiResponse: "",
    screenshot,
  };

  const turns = collectTurns(adapter, root);
  const turn = turnContaining(adapter, turns, element);
  if (!turn) return base;

  if (adapter.roleOf(turn) === "user") {
    return { ...base, parentUserMessage: turnText(adapter, turn) };
  }

  return { ...base, ...surroundingsOf(adapter, turns, turn) };
}

/**
 * Context for the current selection on the current page, or `null` when the
 * selection isn't inside an AI response on a supported site.
 */
export function getSelectionContext(selection: Selection): ContextPackage | null {
  const adapter = getAdapterForHost(window.location.hostname);
  if (!adapter) return null;
  return extractContext(selection, adapter, document);
}

/**
 * The element under the centre of a captured region.
 *
 * `elementFromPoint` takes viewport coordinates, which is exactly what the
 * capture rect is in, and returns the *topmost* element — so this has to be
 * called with the capture overlay already torn down and the panel hidden, or it
 * reports our own UI instead of the page. The centre is clamped into the
 * viewport because a drag that ran off the edge of the window is clamped too.
 *
 * jsdom has no layout and does not implement `elementFromPoint`, so this
 * degrades to `null` there rather than throwing; the extraction it feeds is
 * tested directly through `extractRegionContext`.
 */
export function elementUnderRegion(rect: Rect, doc: Document = document): Element | null {
  const maxX = Math.max(0, doc.documentElement.clientWidth - 1);
  const maxY = Math.max(0, doc.documentElement.clientHeight - 1);
  const x = Math.min(Math.max(rect.x + rect.width / 2, 0), maxX);
  const y = Math.min(Math.max(rect.y + rect.height / 2, 0), maxY);

  try {
    return doc.elementFromPoint?.(x, y) ?? null;
  } catch {
    return null;
  }
}

/**
 * Context for a region captured on the current page. Mirrors
 * `getSelectionContext`: this half reads the live document and the window's
 * host, `extractRegionContext` holds the logic worth testing.
 */
export function getRegionContext(
  screenshot: ImageAttachment,
  element: Element | null,
): ContextPackage {
  const adapter = getAdapterForHost(window.location.hostname);
  if (!adapter) {
    return {
      selectedText: "",
      parentUserMessage: "",
      parentAiResponse: "",
      screenshot,
    };
  }
  return extractRegionContext(element, screenshot, adapter, document);
}
