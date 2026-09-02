/**
 * Minimal DOM fixture modeling ChatGPT's real turn structure well enough to
 * exercise context.ts: each turn is a `[data-message-author-role]` element
 * wrapping a text node, in document order.
 */
export type FixtureTurn = { role: "user" | "assistant"; text: string };

const FIXTURE_ROOT_ID = "sidechats-fixture-root";

/** Renders turns as children of a container appended to document.body. */
export function renderChatGptTurns(turns: FixtureTurn[]): HTMLElement[] {
  const container = document.createElement("div");
  container.id = FIXTURE_ROOT_ID;
  document.body.appendChild(container);

  return turns.map(({ role, text }) => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-message-author-role", role);
    const inner = document.createElement("p");
    inner.textContent = text;
    wrapper.appendChild(inner);
    container.appendChild(wrapper);
    return wrapper;
  });
}

/** Same as renderChatGptTurns, but never appended to document — for exercising
 * the assistantIndex === -1 fallback in context.ts. */
export function renderDetachedTurn(turn: FixtureTurn): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-message-author-role", turn.role);
  const inner = document.createElement("p");
  inner.textContent = turn.text;
  wrapper.appendChild(inner);
  return wrapper;
}

/** Returns the text node inside a turn element's inner paragraph. */
export function textNodeOf(turn: Element): Text {
  const node = turn.querySelector("p")?.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) {
    throw new Error("fixture turn has no text node");
  }
  return node as Text;
}

export function clearFixtures(): void {
  document.getElementById(FIXTURE_ROOT_ID)?.remove();
}
