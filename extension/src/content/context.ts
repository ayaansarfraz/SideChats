import type { ContextPackage, Role } from "../shared/types";
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

/** The turn containing `node`, or `null` if it sits outside the conversation. */
function turnContaining(turns: Element[], node: Node | null): Element | null {
  const el = elementOf(node);
  if (!el) return null;
  return turns.find((turn) => turn.contains(el)) ?? null;
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
function resolveTurn(turns: Element[], selection: Selection): Element | null {
  for (const candidate of [selection.anchorNode, selection.focusNode]) {
    const turn = turnContaining(turns, candidate);
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
  return (el as HTMLElement).innerText?.trim() ?? el.textContent?.trim() ?? "";
}

/**
 * The turn's text with UI chrome stripped.
 *
 * `innerText` needs layout, so a detached clone would silently degrade to
 * `textContent` and lose every line break. The stripped copy is measured in an
 * off-screen host attached to the same document instead — same stylesheets,
 * same line breaking, and the live turn is never mutated.
 */
function textWithoutNoise(el: Element, noiseSelector: string): string {
  const doc = el.ownerDocument;
  const body = doc?.body;
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll(noiseSelector).forEach((n) => n.remove());
  if (!body) return rawText(clone);

  const host = doc.createElement("div");
  host.style.cssText =
    "position:absolute;left:-9999px;top:0;width:800px;visibility:hidden;pointer-events:none;";
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
  if (turns.length === 0) return null;

  const turn = resolveTurn(turns, selection);
  // Side chats branch off what the AI said, so a selection in the user's own
  // message (or in page furniture outside the conversation) is not askable.
  if (!turn || adapter.roleOf(turn) !== "assistant") return null;

  const assistantIndex = turns.indexOf(turn);
  const parentAiResponse = turnText(adapter, turn);

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
    selectedText,
    parentUserMessage,
    parentAiResponse,
    ...(priorContext ? { priorContext } : {}),
  };
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
