// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { handleRequest as HandleRequestType } from "./background";

// background.ts calls chrome.runtime.onMessage.addListener at module scope,
// so `chrome` must be stubbed before the module is ever imported. A dynamic
// import (inside beforeAll, after the stub) avoids static-import hoisting.
let handleRequest: typeof HandleRequestType;

beforeAll(async () => {
  vi.stubGlobal("chrome", {
    runtime: { onMessage: { addListener: vi.fn() } },
  });
  ({ handleRequest } = await import("./background"));
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

const createPayload = {
  selectedText: "timeslice",
  parentUserMessage: "Explain the OS scheduler.",
  parentAiResponse: "The kernel context-switches after a timeslice.",
  question: "What does that mean?",
};

describe("handleRequest", () => {
  it("returns ok:true with sideChatId and reply on a successful CREATE_SIDE_CHAT", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ sideChatId: "abc", reply: "a reply" }), { status: 201 }),
    );

    const res = await handleRequest({ type: "CREATE_SIDE_CHAT", payload: createPayload });

    expect(res).toEqual({ ok: true, sideChatId: "abc", reply: "a reply" });
  });

  it("returns ok:false, errorType:'http' with the server's error body on a non-2xx response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "Failed to get a reply from the model" }), { status: 502 }),
    );

    const res = await handleRequest({ type: "CREATE_SIDE_CHAT", payload: createPayload });

    expect(res).toEqual({
      ok: false,
      error: "Failed to get a reply from the model",
      errorType: "http",
    });
  });

  it("falls back to a status-based message when a non-2xx response has no JSON body", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("not json", { status: 500 }));

    const res = await handleRequest({
      type: "SEND_MESSAGE",
      payload: { sideChatId: "abc", question: "q" },
    });

    expect(res).toEqual({ ok: false, error: "Request failed with status 500", errorType: "http" });
  });

  it("returns ok:false, errorType:'network' when fetch throws (server unreachable)", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Failed to fetch"));

    const res = await handleRequest({ type: "CREATE_SIDE_CHAT", payload: createPayload });

    expect(res).toEqual({ ok: false, error: "Failed to fetch", errorType: "network" });
  });

  it("relays SEND_MESSAGE success with the given sideChatId", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ reply: "follow-up reply" }), { status: 200 }),
    );

    const res = await handleRequest({
      type: "SEND_MESSAGE",
      payload: { sideChatId: "abc", question: "why does that matter?" },
    });

    expect(res).toEqual({ ok: true, sideChatId: "abc", reply: "follow-up reply" });
  });
});
