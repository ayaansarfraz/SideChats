/**
 * Noticing that a single-page app has moved to a different conversation.
 *
 * Neither ChatGPT nor Claude reloads the page when you switch threads, so
 * nothing re-injects the content script and nothing tells it the ground moved.
 * That was survivable while a side chat lived and died with the panel; now that
 * a side chat belongs to a conversation URL, it isn't — the panel would keep
 * showing a branch off a thread the user has left.
 *
 * The obvious approach — monkey-patching `history.pushState` — does not work
 * here. A content script runs in an isolated world with its own copy of the
 * JavaScript globals, so a patched `pushState` only ever sees calls the content
 * script itself makes, never the host app's. What *does* cross the boundary is
 * DOM events (`popstate`) and the URL itself. So: listen for the one event that
 * is real, and poll for the case it doesn't cover, which is every in-app
 * navigation. Comparing two strings twice a second costs nothing measurable.
 */

/** How often to re-read the URL. Fast enough to feel immediate, cheap enough not to matter. */
export const URL_POLL_MS = 500;

export type UrlWatcher = { stop: () => void };

/**
 * Call `onChange` whenever the page's URL changes, with the new URL.
 *
 * `getHref` and the timer functions are injected so the polling half can be
 * tested without a real browser or a real clock.
 */
export function onUrlChange(
  onChange: (url: string) => void,
  options: {
    getHref?: () => string;
    setInterval?: (handler: () => void, ms: number) => number;
    clearInterval?: (id: number) => void;
    addEventListener?: (type: "popstate", handler: () => void) => void;
    removeEventListener?: (type: "popstate", handler: () => void) => void;
  } = {},
): UrlWatcher {
  const getHref = options.getHref ?? (() => window.location.href);
  const start = options.setInterval ?? ((handler, ms) => window.setInterval(handler, ms));
  const stopTimer = options.clearInterval ?? ((id) => window.clearInterval(id));
  const listen = options.addEventListener ?? ((type, handler) => window.addEventListener(type, handler));
  const unlisten =
    options.removeEventListener ?? ((type, handler) => window.removeEventListener(type, handler));

  let lastHref = getHref();

  function check(): void {
    const href = getHref();
    if (href === lastHref) return;
    lastHref = href;
    onChange(href);
  }

  // Back/forward updates the URL before dispatching, so this can read it
  // directly; a pushState hasn't necessarily settled by the time anything
  // observable happens, which is what the poll is for.
  listen("popstate", check);
  const timer = start(check, URL_POLL_MS);

  return {
    stop() {
      unlisten("popstate", check);
      stopTimer(timer);
    },
  };
}
