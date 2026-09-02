import { describe, expect, it } from "vitest";
import type { ExtensionRequest, ExtensionResponse } from "./messages";

/**
 * messages.ts is pure types with no runtime code. These exhaustive switches
 * are the test: if a variant is ever added or renamed without updating them,
 * the `never` assertion in the default branch fails to compile, catching a
 * broken content-script/background-worker contract at build time.
 */
function describeRequest(req: ExtensionRequest): string {
  switch (req.type) {
    case "CREATE_SIDE_CHAT":
      return `create: ${req.payload.question}`;
    case "SEND_MESSAGE":
      return `send to ${req.payload.sideChatId}: ${req.payload.question}`;
    default: {
      const exhaustive: never = req;
      throw new Error(`unhandled request: ${exhaustive}`);
    }
  }
}

function describeResponse(res: ExtensionResponse): string {
  if (res.ok) {
    return `ok: ${res.sideChatId} -> ${res.reply}`;
  }
  switch (res.errorType) {
    case "network":
      return `network error: ${res.error}`;
    case "http":
      return `http error: ${res.error}`;
    default: {
      const exhaustive: never = res.errorType;
      throw new Error(`unhandled error type: ${exhaustive}`);
    }
  }
}

describe("ExtensionRequest", () => {
  it("describes a CREATE_SIDE_CHAT request", () => {
    const req: ExtensionRequest = {
      type: "CREATE_SIDE_CHAT",
      payload: {
        selectedText: "timeslice",
        parentUserMessage: "u",
        parentAiResponse: "a",
        question: "what does that mean?",
      },
    };
    expect(describeRequest(req)).toBe("create: what does that mean?");
  });

  it("describes a SEND_MESSAGE request", () => {
    const req: ExtensionRequest = {
      type: "SEND_MESSAGE",
      payload: { sideChatId: "abc", question: "why?" },
    };
    expect(describeRequest(req)).toBe("send to abc: why?");
  });
});

describe("ExtensionResponse", () => {
  it("describes a success response", () => {
    const res: ExtensionResponse = { ok: true, sideChatId: "abc", reply: "hi" };
    expect(describeResponse(res)).toBe("ok: abc -> hi");
  });

  it("describes a network-error response", () => {
    const res: ExtensionResponse = { ok: false, error: "Failed to fetch", errorType: "network" };
    expect(describeResponse(res)).toBe("network error: Failed to fetch");
  });

  it("describes an http-error response", () => {
    const res: ExtensionResponse = {
      ok: false,
      error: "Side chat not found",
      errorType: "http",
    };
    expect(describeResponse(res)).toBe("http error: Side chat not found");
  });
});
