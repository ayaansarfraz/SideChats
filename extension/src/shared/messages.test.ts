import { describe, expect, it } from "vitest";
import type { BackgroundMessage, ExtensionRequest, ExtensionResponse } from "./messages";

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
    case "CAPTURE_REGION":
      return `capture ${req.payload.rect.width}x${req.payload.rect.height} @${req.payload.devicePixelRatio}x`;
    default: {
      const exhaustive: never = req;
      throw new Error(`unhandled request: ${exhaustive}`);
    }
  }
}

function describeResponse(res: ExtensionResponse): string {
  if (res.ok) {
    switch (res.kind) {
      case "reply":
        return `ok: ${res.sideChatId} -> ${res.reply}`;
      case "image":
        return `ok: image ${res.image.width}x${res.image.height}`;
      default: {
        const exhaustive: never = res;
        throw new Error(`unhandled success kind: ${JSON.stringify(exhaustive)}`);
      }
    }
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

function describeBackgroundMessage(msg: BackgroundMessage): string {
  switch (msg.type) {
    case "START_REGION_CAPTURE":
      return "start region capture";
    default: {
      const exhaustive: never = msg.type;
      throw new Error(`unhandled background message: ${exhaustive}`);
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

  it("describes a CAPTURE_REGION request", () => {
    const req: ExtensionRequest = {
      type: "CAPTURE_REGION",
      payload: { rect: { x: 0, y: 0, width: 400, height: 300 }, devicePixelRatio: 2 },
    };
    expect(describeRequest(req)).toBe("capture 400x300 @2x");
  });

  it("carries images on both message-sending requests", () => {
    const image = {
      id: "img-1",
      mediaType: "image/png" as const,
      data: "aGk=",
      width: 10,
      height: 10,
      byteSize: 2,
    };
    const create: ExtensionRequest = {
      type: "CREATE_SIDE_CHAT",
      payload: {
        selectedText: "",
        parentUserMessage: "",
        parentAiResponse: "",
        question: "",
        images: [image],
      },
    };
    const send: ExtensionRequest = {
      type: "SEND_MESSAGE",
      payload: { sideChatId: "abc", question: "", images: [image] },
    };
    expect(describeRequest(create)).toBe("create: ");
    expect(describeRequest(send)).toBe("send to abc: ");
  });
});

describe("ExtensionResponse", () => {
  it("describes a reply response", () => {
    const res: ExtensionResponse = { ok: true, kind: "reply", sideChatId: "abc", reply: "hi" };
    expect(describeResponse(res)).toBe("ok: abc -> hi");
  });

  it("describes an image response", () => {
    const res: ExtensionResponse = {
      ok: true,
      kind: "image",
      image: { id: "1", mediaType: "image/png", data: "aGk=", width: 400, height: 300, byteSize: 2 },
    };
    expect(describeResponse(res)).toBe("ok: image 400x300");
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

describe("BackgroundMessage", () => {
  it("describes a START_REGION_CAPTURE message", () => {
    expect(describeBackgroundMessage({ type: "START_REGION_CAPTURE" })).toBe(
      "start region capture",
    );
  });
});
