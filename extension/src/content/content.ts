import { getSelectionContext } from "./context";
import { getAdapterForHost } from "./adapters";
import { initAskButton } from "./askButton";
import { createPanel } from "./panel";
import { initRegionCapture } from "./regionCapture";
import { sendSideChatQuestion } from "./apiClient";
import { isExtensionAlive } from "./runtime";
import { onUrlChange } from "./navigation";
import {
  loadSideChat,
  saveSideChat,
  serverChatLikelyExpired,
  storageKeyForUrl,
} from "./persistence";
import type { BackgroundMessage } from "../shared/messages";
import type { PersistedSideChat } from "../shared/types";

const adapter = getAdapterForHost(window.location.hostname);

/**
 * A restored side chat, with a `sideChatId` the server has almost certainly
 * already swept dropped.
 *
 * The transcript is still worth showing — it is what the user wrote and read.
 * Only the id is stale, and keeping it would buy nothing but a round trip that
 * comes back 404 before the panel starts a fresh chat anyway.
 */
function withUsableChatId(record: PersistedSideChat): PersistedSideChat {
  return serverChatLikelyExpired(record) ? { ...record, sideChatId: null } : record;
}

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

  // Which conversation this page is, and therefore which stored side chat
  // belongs to it. Reassigned on in-app navigation below.
  let storageKey = storageKeyForUrl(window.location.href);

  const panel = createPanel({
    // The panel signs itself in the host site's own accent, so it reads as
    // deliberate next to whichever product it is overlaying.
    accentColor: adapter.accentColor,
    // The panel knows when the thread changed; only this file knows which
    // conversation it belongs to. Writes are fire-and-forget — a failed save
    // costs the next restore and nothing the user is doing right now.
    onPersist: (record) => void saveSideChat(storageKey, record),
    // `state.messages` is the thread as it stood before this question: empty
    // for a new side chat, and the seed for one the server has since dropped.
    onSubmit: (question, state, images) =>
      sendSideChatQuestion(state.contextPackage, state.sideChatId, question, images, state.messages),
  });

  // Bring back whatever this conversation had open before the page reloaded.
  // Async, while the rest of setup stays synchronous: a stored thread arriving
  // a tick late is invisible, and blocking the Ask button on a storage read
  // would not be.
  void loadSideChat(storageKey).then((record) => {
    if (record) panel.restore(withUsableChatId(record));
  });

  // ChatGPT and Claude both switch conversations without reloading, so the page
  // can become a different conversation under a panel that is still showing the
  // last one's branch.
  onUrlChange(() => {
    const nextKey = storageKeyForUrl(window.location.href);
    if (nextKey === storageKey) return;
    storageKey = nextKey;
    void loadSideChat(nextKey).then((record) => {
      // Navigated again while this read was in flight; that navigation's own
      // read is the one that should win.
      if (storageKey !== nextKey) return;
      if (record) panel.restore(withUsableChatId(record));
      else panel.reset();
    });
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
