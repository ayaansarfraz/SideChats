import type { SiteAdapter } from "./types";

const AUTHOR_ROLE_ATTR = "data-message-author-role";

/**
 * ChatGPT tags every message with `data-message-author-role="user" | "assistant"`,
 * so one attribute does both jobs: finding turns and classifying them.
 *
 * This is the behaviour the extension shipped with; it is unchanged, just moved
 * behind the adapter interface.
 */
export const chatgptAdapter: SiteAdapter = {
  id: "chatgpt",
  label: "ChatGPT",
  hosts: ["chatgpt.com", "chat.openai.com"],
  turnSelector: `[${AUTHOR_ROLE_ATTR}]`,

  roleOf(el) {
    const role = el.getAttribute(AUTHOR_ROLE_ATTR);
    return role === "user" || role === "assistant" ? role : null;
  },

  // Code blocks render a "Copy code" control inside the message body, which
  // otherwise lands in the middle of the extracted response text.
  noiseSelectors: ["button"],

  accentColor: "#10a37f",
};
