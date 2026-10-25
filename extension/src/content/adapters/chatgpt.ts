import type { Role } from "../../shared/types";
import type { SiteAdapter } from "./types";

const AUTHOR_ROLE_ATTR = "data-message-author-role";
const TURN_ATTR = "data-turn";
const UNIT_KEY_ATTR = "data-content-search-unit-key";

/**
 * ChatGPT marks a turn in more than one way, and which ones are present has
 * shifted between releases:
 *
 * - `article[data-turn="user" | "assistant"]` — the whole turn, including the
 *   "ChatGPT said:" heading and the action bar.
 * - `[data-testid^="conversation-turn-"]` — the same article, by test id.
 * - `[data-message-author-role]` — the message body inside it. Older markup had
 *   only this, and an assistant turn that used tools can hold several.
 * - `[data-content-search-unit-key="<turn>:<n>:<role>"]` — one message, with its
 *   role as the key's last segment. The October 2026 markup has only this: no
 *   article, no role attribute. Its enclosing `[data-turn-key]` holds the
 *   question *and* the answer, so that one is deliberately not a turn here.
 *
 * Listing all of them is a fallback chain: `collectTurns` keeps the outermost
 * match, so when the article is present it is the turn (and multi-part answers
 * stay one turn), and when it is gone the role element still matches on its
 * own. Relying on the role attribute alone is what broke the Ask button when
 * the markup moved.
 */
const TURN_SELECTORS = [
  `article[${TURN_ATTR}]`,
  '[data-testid^="conversation-turn-"]',
  `[${AUTHOR_ROLE_ATTR}]`,
  `[${UNIT_KEY_ATTR}]`,
];

function asRole(value: string | null | undefined): Role | null {
  return value === "user" || value === "assistant" ? value : null;
}

/** `"fallback-turn-0:1:assistant"` → `"assistant"`. */
function roleFromUnitKey(value: string | null): Role | null {
  return value ? asRole(value.slice(value.lastIndexOf(":") + 1)) : null;
}

export const chatgptAdapter: SiteAdapter = {
  id: "chatgpt",
  label: "ChatGPT",
  hosts: ["chatgpt.com", "chat.openai.com"],
  turnSelector: TURN_SELECTORS.join(","),

  roleOf(el) {
    // A wrapper that carries no role of its own takes the role of the message
    // inside it. Returning null for it instead would hide that message too:
    // `collectTurns` drops any match nested in another match.
    return (
      asRole(el.getAttribute(AUTHOR_ROLE_ATTR)) ??
      asRole(el.getAttribute(TURN_ATTR)) ??
      roleFromUnitKey(el.getAttribute(UNIT_KEY_ATTR)) ??
      asRole(el.querySelector(`[${AUTHOR_ROLE_ATTR}]`)?.getAttribute(AUTHOR_ROLE_ATTR))
    );
  },

  // Code blocks render a "Copy code" control inside the message body, which
  // otherwise lands in the middle of the extracted response text. `.sr-only`
  // is the screen-reader "You said:" / "ChatGPT said:" heading on each turn.
  noiseSelectors: ["button", ".sr-only"],

  accentColor: "#10a37f",
};
