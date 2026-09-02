import { getSelectionContext } from "./context";
import { getAdapterForHost } from "./adapters";
import { initAskButton } from "./askButton";
import { createPanel } from "./panel";
import { askSideChat, continueSideChat } from "./apiClient";
import { isExtensionAlive } from "./runtime";

const adapter = getAdapterForHost(window.location.hostname);

if (!adapter) {
  // manifest.json injects this script per host, so reaching here means the
  // manifest's match patterns and the adapter list have drifted apart.
  console.warn(
    "[SideChats] no site adapter for",
    window.location.hostname,
    "— side chats are disabled on this page.",
  );
} else {
  console.log(`[SideChats] loaded on ${window.location.hostname} (${adapter.label} adapter)`);

  const panel = createPanel({
    onSubmit: async (question, state) => {
      if (!state.sideChatId) {
        const { sideChatId, reply } = await askSideChat(state.contextPackage, question);
        return { reply, sideChatId };
      }
      const { reply } = await continueSideChat(state.sideChatId, question);
      return { reply };
    },
  });

  initAskButton(
    // A content script outlives the extension that injected it, so once the
    // extension is reloaded this one is still listening on a page it can no
    // longer act for. Withholding the button is the honest response: offering
    // "Ask" and then failing on submit is worse than not offering it.
    (selection) => (isExtensionAlive() ? getSelectionContext(selection) : null),
    (ctx) => panel.open(ctx),
    { accentColor: adapter.accentColor },
  );
}
