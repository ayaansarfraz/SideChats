/**
 * Guards against the content script outliving the extension that injected it.
 *
 * Chrome does not unload content scripts when an extension is reloaded,
 * updated, or disabled. The script keeps running in the page with its DOM
 * listeners intact, but its bridge back to the extension is severed: every
 * `chrome.runtime` call then throws "Extension context invalidated." This
 * happens constantly during development (each rebuild + reload on
 * chrome://extensions orphans every open tab) and to real users on any
 * extension update.
 *
 * Nothing can reconnect a severed context — the objects are gone, not asleep.
 * Only a page reload injects a fresh content script. So the whole job here is
 * to notice, say so in words that name the fix, and stop offering actions that
 * cannot work.
 */

/** What the user is told when the context is gone. Names the remedy. */
export const EXTENSION_RELOADED_MESSAGE =
  "SideChats was updated or reloaded, so this page lost its connection to it. Reload the page to keep going — your side chat starts fresh.";

/** Thrown in place of Chrome's raw, unactionable error string. */
export class ExtensionContextInvalidatedError extends Error {
  constructor() {
    super(EXTENSION_RELOADED_MESSAGE);
    this.name = "ExtensionContextInvalidatedError";
  }
}

/**
 * Whether this content script can still reach its extension.
 *
 * `chrome.runtime.id` is the cheapest reliable probe: it is a plain property
 * read that goes undefined the moment the context dies, so it costs nothing to
 * call before every send. Reading `chrome.runtime` can itself throw once the
 * context is gone, hence the try/catch.
 */
export function isExtensionAlive(): boolean {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

/**
 * Whether an error thrown by a `chrome.runtime` call means the context died.
 *
 * Chrome signals this only through the message text, so matching on it is
 * unavoidable. It is matched loosely, and callers pair it with an
 * `isExtensionAlive()` check, so a reworded Chrome message degrades to a
 * generic error rather than a wrong diagnosis.
 */
export function isContextInvalidatedError(err: unknown): boolean {
  if (err instanceof ExtensionContextInvalidatedError) return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /extension context invalidated|extension is disabled|context invalidated/i.test(message);
}
