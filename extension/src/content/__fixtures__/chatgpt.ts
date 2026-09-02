/**
 * Minimal DOM fixture modeling ChatGPT's turn structure well enough to
 * exercise context.ts: each turn is a `[data-message-author-role]` element
 * wrapping a text node, in document order. Callers are expected to reset
 * `document.body` between tests (see context.test.ts's afterEach).
 */
export type FixtureTurn = { role: "user" | "assistant"; text: string };

/** Renders turns as children of `document.body`, in order. */
export function renderChatGptTurns(turns: FixtureTurn[]): HTMLElement[] {
  return turns.map(({ role, text }) => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-message-author-role", role);
    const inner = document.createElement("p");
    inner.textContent = text;
    wrapper.appendChild(inner);
    document.body.appendChild(wrapper);
    return wrapper;
  });
}

/** A turn built but never appended to `document` — for exercising the
 * detached-turn fallback in context.ts's `turnContaining`. */
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

/** Renders plain text directly under document.body — page furniture that
 * isn't part of any turn. */
export function renderOutsideText(text: string): HTMLElement {
  const el = document.createElement("p");
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}
