import type { ContextPackage } from "../shared/types";

const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
const USER_SELECTOR = '[data-message-author-role="user"]';
const TURN_SELECTOR = '[data-message-author-role]';

function closestFrom(node: Node, selector: string): Element | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return el ? el.closest(selector) : null;
}

/**
 * Walks backward through turns in document order rather than relying on
 * `previousElementSibling` — ChatGPT wraps each turn in extra layout divs,
 * so the DOM siblings of a turn element aren't necessarily other turns.
 */
function previousTurn(all: Element[], fromIndex: number, selector: string): Element | null {
  for (let i = fromIndex - 1; i >= 0; i--) {
    if (all[i].matches(selector)) return all[i];
  }
  return null;
}

function innerText(el: Element): string {
  return (el as HTMLElement).innerText?.trim() ?? el.textContent?.trim() ?? "";
}

export function getSelectionContext(selection: Selection): ContextPackage | null {
  if (!selection || selection.rangeCount === 0) return null;

  const selectedText = selection.toString();
  if (!selectedText.trim()) return null;

  const anchorNode = selection.anchorNode;
  if (!anchorNode) return null;

  const assistantTurn = closestFrom(anchorNode, ASSISTANT_SELECTOR);
  if (!assistantTurn) return null;

  const parentAiResponse = innerText(assistantTurn);

  const allTurns = Array.from(document.querySelectorAll<Element>(TURN_SELECTOR));
  const assistantIndex = allTurns.indexOf(assistantTurn);

  const userTurn =
    assistantIndex === -1 ? null : previousTurn(allTurns, assistantIndex, USER_SELECTOR);
  const parentUserMessage = userTurn ? innerText(userTurn) : "";

  let priorContext: string | undefined;
  if (userTurn) {
    const userIndex = allTurns.indexOf(userTurn);
    const priorAssistantTurn = previousTurn(allTurns, userIndex, ASSISTANT_SELECTOR);
    if (priorAssistantTurn) {
      const priorAssistantIndex = allTurns.indexOf(priorAssistantTurn);
      const priorUserTurn = previousTurn(allTurns, priorAssistantIndex, USER_SELECTOR);
      const parts: string[] = [];
      if (priorUserTurn) parts.push(`User: ${innerText(priorUserTurn)}`);
      parts.push(`Assistant: ${innerText(priorAssistantTurn)}`);
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
