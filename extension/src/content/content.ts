import { getSelectionContext } from "./context";
import { initAskButton } from "./askButton";
import { createPanel } from "./panel";
import { askSideChat, continueSideChat } from "./apiClient";

console.log("[SideChats] content script loaded on", window.location.hostname);

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

initAskButton(getSelectionContext, (ctx) => panel.open(ctx));
