import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedSideChat } from "../shared/types";
import {
  MAX_STORED_CHATS,
  SERVER_TTL_MS,
  clearSideChat,
  loadSideChat,
  saveSideChat,
  serverChatLikelyExpired,
  storageKeyForUrl,
} from "./persistence";

/**
 * A stand-in for `chrome.storage.local` that behaves like the real one in the
 * ways these tests care about: promise-returning, `get(null)` means "the whole
 * namespace", and `set` can be made to reject the way a quota failure does.
 */
function fakeStorage(options: { rejectOnce?: boolean } = {}) {
  const data = new Map<string, unknown>();
  let rejectNext = options.rejectOnce ?? false;

  return {
    data,
    setCalls: [] as unknown[],
    local: {
      get: vi.fn(async (key: string | null) => {
        if (key === null) return Object.fromEntries(data);
        return data.has(key) ? { [key]: data.get(key) } : {};
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        if (rejectNext) {
          rejectNext = false;
          throw new Error("QUOTA_BYTES quota exceeded");
        }
        for (const [key, value] of Object.entries(items)) data.set(key, value);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
      }),
    },
  };
}

function record(overrides: Partial<PersistedSideChat> = {}): PersistedSideChat {
  return {
    sideChatId: "chat-1",
    contextPackage: { selectedText: "timeslice", parentUserMessage: "u", parentAiResponse: "a" },
    messages: [{ role: "user", content: "why?" }],
    isOpen: true,
    savedAt: Date.now(),
    ...overrides,
  };
}

const image = {
  id: "img-1",
  mediaType: "image/png" as const,
  data: "aGk=",
  width: 8,
  height: 8,
  byteSize: 2,
};

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal("chrome", { storage });
});

describe("storageKeyForUrl", () => {
  it("keys a side chat to the conversation it branched off", () => {
    expect(storageKeyForUrl("https://chatgpt.com/c/abc-123")).toBe("sidechat:chatgpt.com/c/abc-123");
    expect(storageKeyForUrl("https://claude.ai/chat/xyz")).toBe("sidechat:claude.ai/chat/xyz");
  });

  it("treats the same conversation seen differently as the same conversation", () => {
    const plain = storageKeyForUrl("https://chatgpt.com/c/abc");
    expect(storageKeyForUrl("https://chatgpt.com/c/abc/")).toBe(plain);
    expect(storageKeyForUrl("https://chatgpt.com/c/abc?model=gpt-5")).toBe(plain);
    expect(storageKeyForUrl("https://chatgpt.com/c/abc#top")).toBe(plain);
  });

  it("separates two different conversations on the same host", () => {
    expect(storageKeyForUrl("https://chatgpt.com/c/abc")).not.toBe(
      storageKeyForUrl("https://chatgpt.com/c/def"),
    );
  });

  it("still produces a key for something that isn't a URL", () => {
    expect(storageKeyForUrl("not a url")).toBe("sidechat:unknown");
  });
});

describe("saving and loading", () => {
  it("round-trips a side chat", async () => {
    await saveSideChat("sidechat:a", record());
    const loaded = await loadSideChat("sidechat:a");

    expect(loaded?.sideChatId).toBe("chat-1");
    expect(loaded?.messages).toEqual([{ role: "user", content: "why?" }]);
  });

  it("stamps savedAt at write time rather than trusting the caller", async () => {
    await saveSideChat("sidechat:a", record({ savedAt: 0 }));
    expect((await loadSideChat("sidechat:a"))!.savedAt).toBeGreaterThan(0);
  });

  it("reports nothing for a key that was never written", async () => {
    expect(await loadSideChat("sidechat:missing")).toBeNull();
  });

  it("ignores a stored value that isn't a side chat", async () => {
    storage.data.set("sidechat:a", { something: "else" });
    expect(await loadSideChat("sidechat:a")).toBeNull();
  });

  it("clears a key", async () => {
    await saveSideChat("sidechat:a", record());
    await clearSideChat("sidechat:a");
    expect(await loadSideChat("sidechat:a")).toBeNull();
  });

  it("survives storage being unreachable rather than taking the panel down", async () => {
    vi.stubGlobal("chrome", {});
    await expect(saveSideChat("sidechat:a", record())).resolves.toBeUndefined();
    expect(await loadSideChat("sidechat:a")).toBeNull();
  });
});

describe("quota defence", () => {
  it("keeps the words when the pictures don't fit", async () => {
    storage = fakeStorage({ rejectOnce: true });
    vi.stubGlobal("chrome", { storage });

    await saveSideChat(
      "sidechat:a",
      record({
        messages: [{ role: "user", content: "what is this?", images: [image] }],
        contextPackage: {
          selectedText: "",
          parentUserMessage: "u",
          parentAiResponse: "a",
          screenshot: image,
        },
      }),
    );

    const loaded = await loadSideChat("sidechat:a");
    expect(loaded!.messages[0].content).toBe("what is this?");
    expect(loaded!.messages[0].images).toBeUndefined();
    expect(loaded!.messages[0].imagesDropped).toBe(true);
    expect(loaded!.contextPackage.screenshot).toBeUndefined();
  });

  it("gives up quietly if even the stripped record won't fit", async () => {
    const failing = fakeStorage();
    failing.local.set.mockRejectedValue(new Error("QUOTA_BYTES quota exceeded"));
    vi.stubGlobal("chrome", { storage: failing });

    await expect(saveSideChat("sidechat:a", record())).resolves.toBeUndefined();
  });
});

describe("keeping the store bounded", () => {
  it(`keeps the ${MAX_STORED_CHATS} most recent conversations and drops the rest`, async () => {
    for (let i = 0; i < MAX_STORED_CHATS + 3; i++) {
      // Written oldest-first, with savedAt spread so the ordering is unambiguous.
      storage.data.set(`sidechat:old-${i}`, record({ savedAt: 1000 + i }));
    }

    await saveSideChat("sidechat:new", record());

    const keys = [...storage.data.keys()].sort();
    expect(keys).toHaveLength(MAX_STORED_CHATS);
    expect(keys).toContain("sidechat:new");
    // The four oldest went; the newest of the old ones stayed.
    expect(keys).not.toContain("sidechat:old-0");
    expect(keys).toContain(`sidechat:old-${MAX_STORED_CHATS + 2}`);
  });

  it("leaves keys that aren't ours alone", async () => {
    storage.data.set("someone-elses-key", { hello: true });
    for (let i = 0; i < MAX_STORED_CHATS + 2; i++) {
      storage.data.set(`sidechat:old-${i}`, record({ savedAt: 1000 + i }));
    }

    await saveSideChat("sidechat:new", record());

    expect(storage.data.has("someone-elses-key")).toBe(true);
  });
});

describe("serverChatLikelyExpired", () => {
  it("is false for a chat saved within the server's idle window", () => {
    const now = Date.now();
    expect(serverChatLikelyExpired(record({ savedAt: now - 60_000 }), now)).toBe(false);
  });

  it("is true once the server would have swept it", () => {
    const now = Date.now();
    expect(serverChatLikelyExpired(record({ savedAt: now - SERVER_TTL_MS - 1 }), now)).toBe(true);
  });
});
