import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/anthropicClient.js", () => ({
  askSideChat: vi.fn(),
}));

import { askSideChat } from "../lib/anthropicClient.js";
import { sideChatsRouter } from "./sideChats.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/side-chats", sideChatsRouter);
  return app;
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

  it("400s when a required field is missing", async () => {
    const app = makeApp();
    const { question, ...rest } = validBody;
    const res = await request(app).post("/api/side-chats").send(rest);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  it("400s on an empty-string question", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/side-chats")
      .send({ ...validBody, question: "" });
    expect(res.status).toBe(400);
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
