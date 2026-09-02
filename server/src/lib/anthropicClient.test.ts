import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, SideChat, StoredImage } from "../types.js";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));

// The SDK client is constructed at module load, so the mock has to stand in for
// the whole class — there is no API key in a test environment.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { askSideChat } from "./anthropicClient.js";

function storedImage(overrides: Partial<StoredImage> = {}): StoredImage {
  return {
    id: "img-1",
    mediaType: "image/png",
    data: "aW1hZ2UtYnl0ZXM=",
    width: 800,
    height: 600,
    ...overrides,
  };
}

function sideChat(overrides: Partial<SideChat> = {}): SideChat {
  return {
    id: "side-chat-1",
    createdAt: 0,
    lastActiveAt: 0,
    parentUserMessage: "Explain the OS scheduler.",
    parentAiResponse: "The kernel context-switches after a timeslice.",
    selectedText: "timeslice",
    messages: [],
    ...overrides,
  };
}

function lastRequest() {
  return create.mock.calls.at(-1)?.[0];
}

describe("askSideChat", () => {
  beforeEach(() => {
    create.mockReset();
    create.mockResolvedValue({ content: [{ type: "text", text: "a real reply" }] });
  });

  it("sends string content when there are no images at all", async () => {
    await askSideChat(sideChat(), "What does that mean?");
    expect(lastRequest().messages).toEqual([{ role: "user", content: "What does that mean?" }]);
  });

  it("returns the first text block", async () => {
    const reply = await askSideChat(sideChat(), "q");
    expect(reply).toBe("a real reply");
  });

  it("throws when the response carries no text block", async () => {
    create.mockResolvedValue({ content: [{ type: "tool_use", id: "t", name: "n", input: {} }] });
    await expect(askSideChat(sideChat(), "q")).rejects.toThrow("no text content");
  });

  it("builds an image block with bare base64 and the declared media type", async () => {
    await askSideChat(sideChat(), "what is this?", [storedImage({ mediaType: "image/jpeg" })]);
    expect(lastRequest().messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "aW1hZ2UtYnl0ZXM=" },
    });
  });

  it("puts images before the text block", async () => {
    await askSideChat(sideChat(), "what is this?", [storedImage()]);
    const content = lastRequest().messages[0].content;
    expect(content.map((b: { type: string }) => b.type)).toEqual(["image", "text"]);
    expect(content[1]).toEqual({ type: "text", text: "what is this?" });
  });

  it("omits the text block entirely for an image with no question", async () => {
    // An empty text block is a 400 from the API; "what is this?" with no words
    // is a legitimate message, and the system prompt carries the intent.
    await askSideChat(sideChat(), "", [storedImage()]);
    const content = lastRequest().messages[0].content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("image");
  });

  it("keeps all three images in order", async () => {
    await askSideChat(sideChat(), "compare these", [
      storedImage({ id: "a", data: "YQ==" }),
      storedImage({ id: "b", data: "Yg==" }),
      storedImage({ id: "c", data: "Yw==" }),
    ]);
    const content = lastRequest().messages[0].content;
    expect(content.map((b: { source?: { data: string } }) => b.source?.data)).toEqual([
      "YQ==",
      "Yg==",
      "Yw==",
      undefined,
    ]);
  });

  it("prepends a stored screenshot to the first user turn", async () => {
    await askSideChat(sideChat({ screenshot: storedImage({ id: "shot", data: "c2hvdA==" }) }), "q");
    const content = lastRequest().messages[0].content;
    expect(content[0].source.data).toBe("c2hvdA==");
    expect(content[1]).toEqual({ type: "text", text: "q" });
  });

  it("puts the screenshot ahead of that turn's own attachments", async () => {
    await askSideChat(
      sideChat({ screenshot: storedImage({ id: "shot", data: "c2hvdA==" }) }),
      "q",
      [storedImage({ id: "own", data: "b3du" })],
    );
    const content = lastRequest().messages[0].content;
    expect(content.map((b: { source?: { data: string } }) => b.source?.data)).toEqual([
      "c2hvdA==",
      "b3du",
      undefined,
    ]);
  });

  it("re-sends the stored screenshot on a follow-up, still on the first turn", async () => {
    // The API is stateless, so the bytes go up every call — but the extension
    // only ever uploaded them once, which is the point of storing them here.
    const history: Message[] = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first reply" },
    ];
    await askSideChat(
      sideChat({ screenshot: storedImage({ id: "shot", data: "c2hvdA==" }), messages: history }),
      "follow-up",
    );

    const messages = lastRequest().messages;
    expect(messages).toHaveLength(3);
    expect(messages[0].content[0].source.data).toBe("c2hvdA==");
    expect(messages[0].content[1]).toEqual({ type: "text", text: "first question" });
    // The screenshot rides the first turn only — not every user turn.
    expect(messages[1].content).toBe("first reply");
    expect(messages[2].content).toBe("follow-up");
  });

  it("keeps images stored on an earlier turn when replaying history", async () => {
    const history: Message[] = [
      { role: "user", content: "look at this", images: [storedImage({ data: "b2xk" })] },
      { role: "assistant", content: "I see it" },
    ];
    await askSideChat(sideChat({ messages: history }), "and now?");
    const messages = lastRequest().messages;
    expect(messages[0].content[0].source.data).toBe("b2xk");
    expect(messages[2].content).toBe("and now?");
  });

  it("tells the model the branch point is a region when there is no selected text", async () => {
    await askSideChat(sideChat({ selectedText: "", screenshot: storedImage() }), "what is this?");
    expect(lastRequest().system).toContain("SELECTED REGION:");
    expect(lastRequest().system).not.toContain("SELECTED TEXT:");
  });

  it("still says SELECTED TEXT when a screenshot rides alongside a real selection", async () => {
    await askSideChat(sideChat({ selectedText: "timeslice", screenshot: storedImage() }), "q");
    expect(lastRequest().system).toContain("SELECTED TEXT:");
    expect(lastRequest().system).toContain("timeslice");
  });
});
