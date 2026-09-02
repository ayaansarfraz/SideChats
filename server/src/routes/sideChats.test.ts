import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/anthropicClient.js", () => ({
  askSideChat: vi.fn(),
}));

import { askSideChat } from "../lib/anthropicClient.js";
import { JSON_BODY_LIMIT, MAX_IMAGE_BYTES } from "../lib/images.js";
import { sideChatsRouter } from "./sideChats.js";

function makeApp() {
  const app = express();
  // Same limit index.ts mounts. The default 100 KB is smaller than a single
  // screenshot, so a test app on the default would 413 before reaching a route
  // and the image cases below would be testing body-parser, not the routes.
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use("/api/side-chats", sideChatsRouter);
  return app;
}

const PNG = Buffer.from("fake-png-bytes").toString("base64");

function image(overrides: Record<string, unknown> = {}) {
  return { id: "img-1", mediaType: "image/png", data: PNG, width: 800, height: 600, ...overrides };
}

/** Base64 that decodes to at least `bytes`, without allocating the bytes. */
function base64OfSize(bytes: number): string {
  return "A".repeat(Math.ceil(bytes / 3) * 4);
}

/** The (sideChat, question, images) triple the route handed the model client. */
function lastAskArgs() {
  return vi.mocked(askSideChat).mock.calls.at(-1)!;
}

const validBody = {
  parentUserMessage: "Explain the OS scheduler.",
  parentAiResponse: "The kernel context-switches after a timeslice.",
  selectedText: "timeslice",
  question: "What does that mean?",
};

describe("POST /api/side-chats", () => {
  beforeEach(() => {
    vi.mocked(askSideChat).mockReset();
  });

  it("400s when a required field is missing, naming the field", async () => {
    const app = makeApp();
    const { question, ...rest } = validBody;
    const res = await request(app).post("/api/side-chats").send(rest);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("question");
    // Names only what actually failed, so a DOM-extraction regression is
    // diagnosable from the error alone.
    expect(res.body.error).not.toContain("selectedText");
  });

  it("names every failing field when more than one is bad", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/side-chats")
      .send({ ...validBody, parentAiResponse: "", selectedText: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("parentAiResponse");
    expect(res.body.error).toContain("selectedText");
  });

  it("400s on an empty-string question", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/side-chats")
      .send({ ...validBody, question: "" });
    expect(res.status).toBe(400);
  });

  it("400s when parentUserMessage is missing entirely (not just empty)", async () => {
    const app = makeApp();
    const { parentUserMessage, ...rest } = validBody;
    const res = await request(app).post("/api/side-chats").send(rest);
    expect(res.status).toBe(400);
  });

  it("201s with an empty-string parentUserMessage (no preceding user turn in the DOM)", async () => {
    // The extension sends "" for this on purpose — the first message in a
    // conversation, or any turn whose preceding user message has scrolled
    // out of a virtualized DOM (e.g. long ChatGPT threads). Regression test
    // for a real bug: this used to 400, contradicting context.ts's own
    // documented/tested behavior of treating "" as valid here.
    vi.mocked(askSideChat).mockResolvedValue("a real reply");
    const app = makeApp();
    const res = await request(app)
      .post("/api/side-chats")
      .send({ ...validBody, parentUserMessage: "" });
    expect(res.status).toBe(201);
    expect(res.body.reply).toBe("a real reply");
  });

  it("201s with a reply on success", async () => {
    vi.mocked(askSideChat).mockResolvedValue("a real reply");
    const app = makeApp();
    const res = await request(app).post("/api/side-chats").send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.reply).toBe("a real reply");
    expect(res.body.sideChatId).toBeTruthy();
  });

  it("502s when the model call fails", async () => {
    vi.mocked(askSideChat).mockRejectedValue(new Error("401 invalid x-api-key"));
    const app = makeApp();
    const res = await request(app).post("/api/side-chats").send(validBody);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Failed to get a reply from the model");
  });
});

describe("POST /api/side-chats/:id/messages", () => {
  beforeEach(() => {
    vi.mocked(askSideChat).mockReset();
  });

  it("404s for an unknown id", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/side-chats/does-not-exist/messages")
      .send({ question: "q" });
    expect(res.status).toBe(404);
  });

  it("400s on missing question for a known id", async () => {
    vi.mocked(askSideChat).mockResolvedValue("first reply");
    const app = makeApp();
    const create = await request(app).post("/api/side-chats").send(validBody);
    const id = create.body.sideChatId;

    const res = await request(app).post(`/api/side-chats/${id}/messages`).send({});
    expect(res.status).toBe(400);
  });

  it("200s with a reply for a follow-up", async () => {
    vi.mocked(askSideChat).mockResolvedValue("first reply");
    const app = makeApp();
    const create = await request(app).post("/api/side-chats").send(validBody);
    const id = create.body.sideChatId;

    vi.mocked(askSideChat).mockResolvedValue("second reply");
    const res = await request(app)
      .post(`/api/side-chats/${id}/messages`)
      .send({ question: "why does that matter?" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("second reply");
  });

  it("502s when the model call fails on a follow-up", async () => {
    vi.mocked(askSideChat).mockResolvedValue("first reply");
    const app = makeApp();
    const create = await request(app).post("/api/side-chats").send(validBody);
    const id = create.body.sideChatId;

    vi.mocked(askSideChat).mockRejectedValue(new Error("529 overloaded"));
    const res = await request(app)
      .post(`/api/side-chats/${id}/messages`)
      .send({ question: "another one" });
    expect(res.status).toBe(502);
  });
});

describe("DELETE /api/side-chats/:id", () => {
  it("404s for an unknown id", async () => {
    const app = makeApp();
    const res = await request(app).delete("/api/side-chats/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("204s for a known id", async () => {
    vi.mocked(askSideChat).mockResolvedValue("reply");
    const app = makeApp();
    const create = await request(app).post("/api/side-chats").send(validBody);
    const id = create.body.sideChatId;

    const res = await request(app).delete(`/api/side-chats/${id}`);
    expect(res.status).toBe(204);
  });
});


describe("images on POST /api/side-chats", () => {
  beforeEach(() => {
    vi.mocked(askSideChat).mockReset();
    vi.mocked(askSideChat).mockResolvedValue("a real reply");
  });

  it("forwards attached images to the model client", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/side-chats")
      .send({ ...validBody, images: [image(), image({ id: "img-2" })] });

    expect(res.status).toBe(201);
    expect(lastAskArgs()[2]?.map((i) => i.id)).toEqual(["img-1", "img-2"]);
  });

  it("stores images on the user turn, so a follow-up replays them", async () => {
    const app = makeApp();
    const create = await request(app)
      .post("/api/side-chats")
      .send({ ...validBody, images: [image()] });

    await request(app)
      .post(`/api/side-chats/${create.body.sideChatId}/messages`)
      .send({ question: "and now?" });

    const [sideChat] = lastAskArgs();
    expect(sideChat.messages[0].images?.map((i) => i.id)).toEqual(["img-1"]);
  });

  it("leaves `images` off a turn that had none, rather than storing an empty array", async () => {
    const app = makeApp();
    const create = await request(app).post("/api/side-chats").send(validBody);
    await request(app)
      .post(`/api/side-chats/${create.body.sideChatId}/messages`)
      .send({ question: "and now?" });

    expect(lastAskArgs()[0].messages[0].images).toBeUndefined();
  });

  it("creates a side chat from a screenshot alone, with no selected text", async () => {
    // A dragged region may sit outside any turn, so the DOM walk has nothing
    // to report — the image is the branch point on its own.
    const app = makeApp();
    const res = await request(app).post("/api/side-chats").send({
      parentUserMessage: "",
      parentAiResponse: "",
      selectedText: "",
      question: "what does this show?",
      screenshot: image({ id: "shot" }),
    });

    expect(res.status).toBe(201);
    expect(lastAskArgs()[0].screenshot?.id).toBe("shot");
  });

  it("accepts a screenshot-seeded create that omits the context fields entirely", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/side-chats")
      .send({ question: "what is this?", screenshot: image({ id: "shot" }) });

    expect(res.status).toBe(201);
    expect(lastAskArgs()[0].parentAiResponse).toBe("");
  });

  it("accepts an image with no question — that is a real 'what is this?'", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/side-chats")
      .send({ ...validBody, question: "", images: [image()] });

    expect(res.status).toBe(201);
    expect(lastAskArgs()[1]).toBe("");
  });

  it("still 400s on an empty question when nothing is attached", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/side-chats")
      .send({ ...validBody, question: "", images: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("question");
  });

  it("keeps requiring selectedText when there is no screenshot", async () => {
    // The relaxation is screenshot-gated: text-only extraction failures must
    // still be diagnosable.
    const app = makeApp();
    const res = await request(app)
      .post("/api/side-chats")
      .send({ ...validBody, selectedText: "", images: [image()] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("selectedText");
  });

  it("rejects a bad mediaType, naming the image and the field", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/side-chats")
      .send({ ...validBody, images: [image(), image({ id: "b", mediaType: "image/svg+xml" })] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("images[1].mediaType");
    expect(askSideChat).not.toHaveBeenCalled();
  });

  it("rejects more than three images", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/side-chats")
      .send({ ...validBody, images: [image(), image(), image(), image()] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("at most 3");
  });

  it("rejects an oversize image on a body far past the 100 KB json default", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/side-chats")
      .send({ ...validBody, images: [image({ data: base64OfSize(MAX_IMAGE_BYTES + 1024) })] });

    // Reaching a 400 at all proves the raised body limit: on the default this
    // request would have 413'd in body-parser.
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("images[0].data");
    expect(res.body.error).toContain("per-image limit");
  });

  it("rejects a malformed screenshot without creating the side chat", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/side-chats")
      .send({ ...validBody, screenshot: { id: "shot", mediaType: "image/png" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("screenshot.data");
    expect(askSideChat).not.toHaveBeenCalled();
  });

  it("names both a missing text field and a bad image in one error", async () => {
    const app = makeApp();
    const { question, ...rest } = validBody;
    const res = await request(app)
      .post("/api/side-chats")
      .send({ ...rest, images: [image({ mediaType: "image/svg+xml" })] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("question");
    expect(res.body.error).toContain("images[0].mediaType");
  });

  it("accepts a ~1 MB image, which the default json limit would have 413'd", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/side-chats")
      .send({ ...validBody, images: [image({ data: base64OfSize(1024 * 1024) })] });
    expect(res.status).toBe(201);
  });
});

describe("images on POST /api/side-chats/:id/messages", () => {
  beforeEach(() => {
    vi.mocked(askSideChat).mockReset();
    vi.mocked(askSideChat).mockResolvedValue("a real reply");
  });

  async function createChat(body: Record<string, unknown> = validBody) {
    const app = makeApp();
    const res = await request(app).post("/api/side-chats").send(body);
    return { app, id: res.body.sideChatId as string };
  }

  it("forwards a follow-up's images", async () => {
    const { app, id } = await createChat();
    const res = await request(app)
      .post(`/api/side-chats/${id}/messages`)
      .send({ question: "and this?", images: [image({ id: "later" })] });

    expect(res.status).toBe(200);
    expect(lastAskArgs()[2]?.map((i) => i.id)).toEqual(["later"]);
  });

  it("accepts a follow-up that is only an image", async () => {
    const { app, id } = await createChat();
    const res = await request(app)
      .post(`/api/side-chats/${id}/messages`)
      .send({ images: [image()] });
    expect(res.status).toBe(200);
  });

  it("still 400s a follow-up with neither question nor image", async () => {
    const { app, id } = await createChat();
    const res = await request(app).post(`/api/side-chats/${id}/messages`).send({});
    expect(res.status).toBe(400);
  });

  it("rejects a bad follow-up image, naming the field", async () => {
    const { app, id } = await createChat();
    const res = await request(app)
      .post(`/api/side-chats/${id}/messages`)
      .send({ question: "q", images: [image({ data: "data:image/png;base64," + PNG })] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("images[0].data");
  });

  it("re-sends the stored screenshot on a follow-up that carries no image", async () => {
    // The extension uploads those bytes once; the API is stateless, so the
    // server is what makes the branch point survive every later turn.
    const { app, id } = await createChat({
      ...validBody,
      selectedText: "",
      screenshot: image({ id: "shot" }),
    });
    const res = await request(app)
      .post(`/api/side-chats/${id}/messages`)
      .send({ question: "and what about the axis?" });

    expect(res.status).toBe(200);
    expect(lastAskArgs()[0].screenshot?.id).toBe("shot");
  });

  it("ignores a screenshot sent on a follow-up — the branch point is fixed", async () => {
    const { app, id } = await createChat();
    const res = await request(app)
      .post(`/api/side-chats/${id}/messages`)
      .send({ question: "q", screenshot: image({ id: "too-late" }) });

    expect(res.status).toBe(200);
    expect(lastAskArgs()[0].screenshot).toBeUndefined();
  });
});
