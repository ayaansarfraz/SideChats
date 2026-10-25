/**
 * Keeping a side chat alive across a dismissal, a reload, or an SPA route
 * change.
 *
 * The extension used to hold a thread in one closure variable in `panel.ts`,
 * which meant a reload was indistinguishable from deleting the conversation.
 * This module is the durable half: `chrome.storage.local`, one record per
 * conversation, written on every state change worth keeping.
 *
 * Two things shape the design more than anything else:
 *
 * 1. **The key is the conversation, not the tab.** A side chat is a branch off
 *    a particular ChatGPT/Claude thread, so it belongs to that thread's URL.
 *    Navigating to a different conversation should not drag the old branch
 *    along, and navigating back should find it again.
 * 2. **Records carry base64 images.** `shared/image.ts` caps an attachment at
 *    2 MB and a message at 3 of them, against a `storage.local` budget of about
 *    10 MB. So writes are defended twice: a quota retry that drops the pictures
 *    rather than losing the words, and a cap on how many conversations are kept.
 */
import type { PersistedChatMessage, PersistedSideChat } from "../shared/types";

/** Namespace for our keys, so `storage.local` stays legible to anything else. */
const KEY_PREFIX = "sidechat:";

/**
 * How many conversations' side chats to keep. Five is enough to cover moving
 * between a handful of threads in a session; past that the oldest is worth less
 * than the quota it occupies.
 */
export const MAX_STORED_CHATS = 5;

/**
 * The server sweeps idle side chats after 30 minutes (`server/src/lib/store.ts`),
 * which makes a stored `sideChatId` older than that a near-certain 404. The
 * transcript is still worth restoring — only the id is stale.
 */
export const SERVER_TTL_MS = 30 * 60 * 1000;

/**
 * Which conversation a side chat belongs to.
 *
 * Host plus pathname, and deliberately not the query string or hash: ChatGPT
 * (`/c/<id>`) and Claude (`/chat/<id>`) both put the conversation's identity in
 * the path, while `?model=…` or a `#anchor` are the same conversation seen
 * slightly differently. A trailing slash is normalised away for the same reason.
 */
export function storageKeyForUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A caller with no usable URL still deserves a stable key rather than a
    // throw — everything lands in one bucket, which is the old behaviour.
    return `${KEY_PREFIX}unknown`;
  }
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  return `${KEY_PREFIX}${parsed.host}${path}`;
}

/** Whether `chrome.storage.local` is reachable from here right now. */
function storageAvailable(): boolean {
  try {
    return Boolean(chrome?.storage?.local);
  } catch {
    // Reading `chrome.storage` throws outright once the extension context has
    // been invalidated out from under this content script.
    return false;
  }
}

/** The same record with every image dropped — the fallback when quota bites. */
function withoutImages(record: PersistedSideChat): PersistedSideChat {
  const messages: PersistedChatMessage[] = record.messages.map(({ images, ...rest }) =>
    images && images.length > 0 ? { ...rest, imagesDropped: true } : rest,
  );
  const contextPackage = { ...record.contextPackage };
  delete contextPackage.screenshot;
  return { ...record, messages, contextPackage };
}

/**
 * Drop the least recently saved records until only `MAX_STORED_CHATS` remain.
 *
 * Runs on every write rather than on a timer: a write is the only moment the
 * set can grow, and reading the whole namespace is cheap next to the base64 we
 * are already moving.
 */
async function evictOldest(keepKey: string): Promise<void> {
  const all = (await chrome.storage.local.get(null)) as Record<string, unknown>;
  const ours = Object.entries(all)
    .filter(([key]) => key.startsWith(KEY_PREFIX) && key !== keepKey)
    .map(([key, value]) => ({ key, savedAt: savedAtOf(value) }))
    .sort((a, b) => b.savedAt - a.savedAt);

  // -1 because the record being written is excluded above but still counts.
  const doomed = ours.slice(MAX_STORED_CHATS - 1).map((entry) => entry.key);
  if (doomed.length > 0) await chrome.storage.local.remove(doomed);
}

function savedAtOf(value: unknown): number {
  const savedAt = (value as PersistedSideChat | null)?.savedAt;
  return typeof savedAt === "number" ? savedAt : 0;
}

/**
 * Write a side chat, `savedAt` stamped here so no caller has to remember to.
 *
 * Never throws: persistence failing is not a reason to break the panel the user
 * is currently typing into. A failed write costs the restore, nothing else.
 */
export async function saveSideChat(key: string, record: PersistedSideChat): Promise<void> {
  if (!storageAvailable()) return;
  const stamped: PersistedSideChat = { ...record, savedAt: Date.now() };

  try {
    await chrome.storage.local.set({ [key]: stamped });
  } catch {
    // Almost always QUOTA_BYTES, and almost always the images. Losing the
    // pictures from a restored thread is a real loss; losing the whole thread
    // because one screenshot was too big is a worse one.
    try {
      await chrome.storage.local.set({ [key]: withoutImages(stamped) });
    } catch {
      return;
    }
  }

  try {
    await evictOldest(key);
  } catch {
    // Eviction is housekeeping. The write already succeeded.
  }
}

/**
 * Read a side chat back, or `null` if there isn't one (or it is unreadable).
 *
 * Storage is validated rather than trusted: these records outlive the build
 * that wrote them, so a shape change or a half-written value has to degrade to
 * "no saved chat" instead of crashing the content script at startup.
 */
export async function loadSideChat(key: string): Promise<PersistedSideChat | null> {
  if (!storageAvailable()) return null;
  try {
    const stored = (await chrome.storage.local.get(key)) as Record<string, unknown>;
    return isPersistedSideChat(stored?.[key]) ? stored[key] : null;
  } catch {
    return null;
  }
}

export async function clearSideChat(key: string): Promise<void> {
  if (!storageAvailable()) return;
  try {
    await chrome.storage.local.remove(key);
  } catch {
    // Nothing to do about it, and nothing depends on it having happened.
  }
}

function isPersistedSideChat(value: unknown): value is PersistedSideChat {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PersistedSideChat>;
  return (
    Array.isArray(record.messages) &&
    typeof record.savedAt === "number" &&
    typeof record.isOpen === "boolean" &&
    !!record.contextPackage &&
    typeof record.contextPackage === "object"
  );
}

/**
 * Whether a restored record's `sideChatId` is old enough that the server has
 * almost certainly swept it. The panel uses this to start a fresh server chat
 * on the next question instead of spending a round trip discovering a 404.
 */
export function serverChatLikelyExpired(record: PersistedSideChat, now = Date.now()): boolean {
  return now - record.savedAt >= SERVER_TTL_MS;
}
