import { getSelectionContext } from "./context";
import { getAdapterForHost } from "./adapters";
import { initAskButton } from "./askButton";
import { createPanel } from "./panel";
import { initRegionCapture } from "./regionCapture";
import { askSideChat, continueSideChat } from "./apiClient";
import { isExtensionAlive } from "./runtime";
import type { BackgroundMessage } from "../shared/messages";

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
    // The panel signs itself in the host site's own accent, so it reads as
    // deliberate next to whichever product it is overlaying.
    accentColor: adapter.accentColor,
    onSubmit: async (question, state, images) => {
      if (!state.sideChatId) {
        const { sideChatId, reply } = await askSideChat(state.contextPackage, question, images);
        return { reply, sideChatId };
      }
      const { reply } = await continueSideChat(state.sideChatId, question, images);
      return { reply };
    },
  });

  const regionCapture = initRegionCapture(
    (image, context) => {
      // Two different intentions land here and only the panel's state tells
      // them apart. A capture taken while a side chat is on screen is another
      // thing to ask about *in that conversation*, so it stages into the
      // composer. A capture taken with nothing open is a new branch point, and
      // has to arrive as `ctx.screenshot` — open() resets panel state, so an
      // addImage() before it would be thrown away.
      if (panel.isOpen()) {
        panel.addImage(image);
      } else {
        panel.open(context);
      }
    },
    {
      hideForCapture: panel.hideForCapture,
      showAfterCapture: panel.showAfterCapture,
      onError: panel.showError,
    },
  );

  // Background → content. The toolbar click that starts a capture arrives at
  // the service worker, which is the only place `chrome.tabs` exists, so it has
  // to be relayed back into the page. `start()` does its own liveness check and
  // explains itself if the extension has been reloaded underneath us.
  chrome.runtime.onMessage.addListener((message: BackgroundMessage) => {
    if (message.type === "START_REGION_CAPTURE") {
      regionCapture.start();
    }
    return false;
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
