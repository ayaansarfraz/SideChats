import { afterEach, describe, expect, it, vi } from "vitest";
import { askSideChat, continueSideChat, sendSideChatQuestion, toPriorMessages } from "./apiClient";
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
    withLiveRuntime(async () => ({ ok: true, kind: "reply" as const, sideChatId: "sc_1", reply: "It means..." }));

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
    withLiveRuntime(async () => ({ ok: true, kind: "reply" as const, sideChatId: "sc_1", reply: "Because..." }));

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

/**
 * The panel keeps a thread across reloads, so it can outlive the server's
 * 30-minute idle sweep and have to re-create the side chat. What it sends as
 * history is not the same as what it shows on screen.
 */
describe("toPriorMessages", () => {
  it("passes a well-formed thread through", () => {
    expect(
      toPriorMessages([
        { role: "user", content: "why?" },
        { role: "assistant", content: "because." },
      ]),
    ).toEqual([
      { role: "user", content: "why?" },
      { role: "assistant", content: "because." },
    ]);
  });

  it("sends no history for a side chat that has none", () => {
    expect(toPriorMessages([])).toEqual([]);
  });

  it("drops a trailing question whose answer never arrived", () => {
    expect(
      toPriorMessages([
        { role: "user", content: "why?" },
        { role: "assistant", content: "because." },
        { role: "user", content: "and then?" },
      ]),
    ).toEqual([
      { role: "user", content: "why?" },
      { role: "assistant", content: "because." },
    ]);
  });

  it("drops the question that errored, not the one that got answered", () => {
    // What the panel holds after a failed send followed by a successful one.
    expect(
      toPriorMessages([
        { role: "user", content: "failed question" },
        { role: "user", content: "retried question" },
        { role: "assistant", content: "an answer" },
      ]),
    ).toEqual([
      { role: "user", content: "retried question" },
      { role: "assistant", content: "an answer" },
    ]);
  });

  it("leaves images behind", () => {
    const history = toPriorMessages([
      {
        role: "user",
        content: "what is this?",
        images: [
          { id: "i", mediaType: "image/png", data: "aGk=", width: 8, height: 8, byteSize: 2 },
        ],
      },
      { role: "assistant", content: "a chart." },
    ]);

    expect(history[0]).toEqual({ role: "user", content: "what is this?" });
  });
});

describe("askSideChat with restored history", () => {
  it("sends the seeded turns alongside the new question", async () => {
    const sent: unknown[] = [];
    withLiveRuntime(async (req) => {
      sent.push(req);
      return { ok: true, kind: "reply" as const, sideChatId: "sc_2", reply: "still here" };
    });

    await askSideChat(CTX, "and then?", [], [
      { role: "user", content: "why?" },
      { role: "assistant", content: "because." },
    ]);

    expect((sent[0] as { payload: { priorMessages: unknown } }).payload.priorMessages).toEqual([
      { role: "user", content: "why?" },
      { role: "assistant", content: "because." },
    ]);
  });

  it("leaves the field off entirely for a genuinely new side chat", async () => {
    const sent: unknown[] = [];
    withLiveRuntime(async (req) => {
      sent.push(req);
      return { ok: true, kind: "reply" as const, sideChatId: "sc_1", reply: "It means..." };
    });

    await askSideChat(CTX, "what does this mean?");

    expect((sent[0] as { payload: Record<string, unknown> }).payload).not.toHaveProperty(
      "priorMessages",
    );
  });
});

describe("sendSideChatQuestion", () => {
  const THREAD = [
    { role: "user" as const, content: "first?" },
    { role: "assistant" as const, content: "first answer" },
  ];

  it("continues a chat the server still has", async () => {
    const sendMessage = vi.fn(async (_req: unknown) => ({ ok: true, kind: "reply" as const, sideChatId: "sc_1", reply: "next" }));
    withLiveRuntime(sendMessage);

    await expect(sendSideChatQuestion(CTX, "sc_1", "again?", [], THREAD)).resolves.toEqual({ reply: "next" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toMatchObject({ type: "SEND_MESSAGE" });
  });

  it("re-creates a chat the server has forgotten, seeded with the thread", async () => {
    const sendMessage = vi.fn(async (req: unknown) =>
      (req as { type: string }).type === "SEND_MESSAGE"
        ? { ok: false, error: "Side chat not found", errorType: "http" }
        : { ok: true, kind: "reply" as const, sideChatId: "sc_2", reply: "fresh" },
    );
    withLiveRuntime(sendMessage);

    await expect(sendSideChatQuestion(CTX, "sc_stale", "again?", [], THREAD)).resolves.toEqual({
      reply: "fresh",
      sideChatId: "sc_2",
    });
    expect(sendMessage.mock.calls[1][0]).toMatchObject({
      type: "CREATE_SIDE_CHAT",
      payload: { question: "again?", priorMessages: THREAD },
    });
  });

  it("does not re-create on any other failure", async () => {
    const sendMessage = vi.fn(async () => ({ ok: false, error: "Request failed with status 502", errorType: "http" }));
    withLiveRuntime(sendMessage);

    await expect(sendSideChatQuestion(CTX, "sc_1", "again?", [], THREAD)).rejects.toThrow("502");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
