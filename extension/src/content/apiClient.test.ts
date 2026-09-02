import { afterEach, describe, expect, it, vi } from "vitest";
import { askSideChat, continueSideChat } from "./apiClient";
import { EXTENSION_RELOADED_MESSAGE } from "./runtime";
import type { ContextPackage } from "../shared/types";

const globalWithChrome = globalThis as { chrome?: unknown };

const CTX: ContextPackage = {
  selectedText: "symmetric difference",
  parentUserMessage: "Why does every tree have at most one?",
  parentAiResponse: "Take the symmetric difference of two matchings.",
};

/** Stub `chrome.runtime` with a live id and the given sendMessage behaviour. */
function withLiveRuntime(sendMessage: (req: unknown) => Promise<unknown>) {
  globalWithChrome.chrome = { runtime: { id: "abcdefghijklmnop", sendMessage } };
}

/** Stub a runtime whose context has been invalidated: no id left. */
function withDeadRuntime() {
  globalWithChrome.chrome = {
    runtime: {
      sendMessage: () => Promise.reject(new Error("Extension context invalidated.")),
    },
  };
}

afterEach(() => {
  delete globalWithChrome.chrome;
});

describe("askSideChat", () => {
  it("returns the reply and id on success", async () => {
    withLiveRuntime(async () => ({ ok: true, sideChatId: "sc_1", reply: "It means..." }));

    await expect(askSideChat(CTX, "what does this mean?")).resolves.toEqual({
      sideChatId: "sc_1",
      reply: "It means...",
    });
  });

  it("reports a reloaded extension in words instead of Chrome's raw string", async () => {
    withDeadRuntime();

    // This is the bug from the screenshot: the panel rendered
    // "Extension context invalidated." verbatim, twice, with no way forward.
    await expect(askSideChat(CTX, "what is this place")).rejects.toThrow(
      EXTENSION_RELOADED_MESSAGE,
    );
  });

  it("does not even attempt a send once the context is dead", async () => {
    const sendMessage = vi.fn();
    globalWithChrome.chrome = { runtime: { sendMessage } };

    await expect(askSideChat(CTX, "hey")).rejects.toThrow(EXTENSION_RELOADED_MESSAGE);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("treats a context that dies mid-send the same way", async () => {
    // The liveness check passed, then the extension was reloaded before the
    // message landed — the id is gone by the time the rejection arrives.
    let sendMessage = async () => {
      globalWithChrome.chrome = { runtime: { sendMessage } };
      throw new Error("Could not establish connection. Receiving end does not exist.");
    };
    withLiveRuntime(sendMessage);

    await expect(askSideChat(CTX, "hey")).rejects.toThrow(EXTENSION_RELOADED_MESSAGE);
  });

  it("treats an unanswered send as a lost context", async () => {
    // sendMessage resolves undefined when no listener replies.
    withLiveRuntime(async () => undefined);

    await expect(askSideChat(CTX, "hey")).rejects.toThrow(EXTENSION_RELOADED_MESSAGE);
  });

  it("passes a real server error through with its own text", async () => {
    withLiveRuntime(async () => ({
      ok: false,
      error: "Request failed with status 502",
      errorType: "http",
    }));

    await expect(askSideChat(CTX, "hey")).rejects.toThrow("Request failed with status 502");
  });

  it("passes an unrelated thrown error through untouched", async () => {
    withLiveRuntime(async () => {
      throw new Error("Something else entirely");
    });

    await expect(askSideChat(CTX, "hey")).rejects.toThrow("Something else entirely");
  });
});

describe("continueSideChat", () => {
  it("returns the reply on success", async () => {
    withLiveRuntime(async () => ({ ok: true, sideChatId: "sc_1", reply: "Because..." }));

    await expect(continueSideChat("sc_1", "why?")).resolves.toEqual({ reply: "Because..." });
  });

  it("reports a reloaded extension in words", async () => {
    withDeadRuntime();

    await expect(continueSideChat("sc_1", "hey")).rejects.toThrow(EXTENSION_RELOADED_MESSAGE);
  });

  it("still surfaces an expired side chat as its own error", async () => {
    // panel.ts keys off this exact string to clear a dead sideChatId, so it
    // must not get rewritten into the reload message.
    withLiveRuntime(async () => ({
      ok: false,
      error: "Side chat not found",
      errorType: "http",
    }));

    await expect(continueSideChat("sc_gone", "hey")).rejects.toThrow("Side chat not found");
  });
});
