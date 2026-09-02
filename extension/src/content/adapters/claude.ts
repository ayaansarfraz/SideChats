import type { SiteAdapter } from "./types";

/**
 * claude.ai does not expose a single `role` attribute the way ChatGPT does, so
 * each side is matched by its own set of selectors and `roleOf` decides which
 * side an element belongs to.
 *
 * Several selectors are listed per role on purpose. claude.ai's markup is
 * utility-class heavy and changes more often than its test ids, so each list is
 * ordered most-durable-first and acts as a fallback chain: if the class names
 * churn, the `data-*` hooks still match, and vice versa. `collectTurns` keeps
 * only the outermost match of a nested group, so listing a wrapper *and* the
 * element it wraps is safe — the wrapper wins and the turn is counted once.
 *
 * These selectors are the part of this extension most likely to rot. If side
 * chats stop opening on claude.ai, this list is the first thing to re-check
 * against the live DOM.
 */
const USER_SELECTORS = [
  '[data-testid="user-message"]',
  '[data-test-render-count] [data-testid="user-message"]',
];

const ASSISTANT_SELECTORS = [
  ".font-claude-response",
  ".font-claude-message",
  "[data-is-streaming]",
];

const USER_SELECTOR = USER_SELECTORS.join(",");
const ASSISTANT_SELECTOR = ASSISTANT_SELECTORS.join(",");

export const claudeAdapter: SiteAdapter = {
  id: "claude",
  label: "Claude",
  hosts: ["claude.ai"],
  turnSelector: [...USER_SELECTORS, ...ASSISTANT_SELECTORS].join(","),

  roleOf(el) {
    // User is checked first: an assistant wrapper never contains a user message,
    // but a generic wrapper selector could in principle match both, and
    // mislabelling a user turn as assistant is the worse failure (it would seed
    // a side chat with the user's own words as the "AI response").
    if (el.matches(USER_SELECTOR)) return "user";
    if (el.matches(ASSISTANT_SELECTOR)) return "assistant";
    return null;
  },

  // Copy / retry / expand controls render inside the message container; their
  // labels are UI chrome, not part of the answer. Note this strips the
  // *toggle* on an extended-thinking block, not the thinking text itself — if
  // that turns out to bloat the context package, add its container here.
  noiseSelectors: ["button", '[data-testid="action-bar"]'],

  accentColor: "#d97757",
};
