import { describe, expect, it } from "vitest";
import { appendMessages, createSideChat, getSideChat, removeSideChat, sweepIdleSideChats } from "./store.js";

function makeInput() {
  return {
    parentUserMessage: "What is a timeslice?",
    parentAiResponse: "A timeslice is a fixed unit of CPU time.",
    selectedText: "timeslice",
  };
}

describe("store", () => {
  it("round-trips create, get, append, and remove", () => {
    const sideChat = createSideChat(makeInput());
    expect(getSideChat(sideChat.id)).toBe(sideChat);

    appendMessages(sideChat.id, [
      { role: "user", content: "What does that mean?" },
      { role: "assistant", content: "It's how long a thread runs before preemption." },
    ]);
    expect(getSideChat(sideChat.id)?.messages).toHaveLength(2);

    expect(removeSideChat(sideChat.id)).toBe(true);
    expect(getSideChat(sideChat.id)).toBeUndefined();
  });

  it("removeSideChat on an unknown id returns false instead of throwing", () => {
    expect(removeSideChat("does-not-exist")).toBe(false);
  });

  it("appendMessages on an unknown/already-removed id is a no-op, not a throw", () => {
    const sideChat = createSideChat(makeInput());
    removeSideChat(sideChat.id);

    // Simulates the idle-sweep race: a reply comes back for a chat that was
    // swept mid-flight. The message is lost, but nothing should crash.
    expect(() => appendMessages(sideChat.id, [{ role: "user", content: "hi" }])).not.toThrow();
    expect(appendMessages(sideChat.id, [{ role: "user", content: "hi" }])).toBeUndefined();
  });

  it("sweepIdleSideChats evicts only chats past the idle TTL", () => {
    const stale = createSideChat(makeInput());
    const fresh = createSideChat(makeInput());

    // 31 minutes ago — past the 30-minute IDLE_TTL_MS.
    stale.lastActiveAt = Date.now() - 31 * 60 * 1000;

    sweepIdleSideChats();

    expect(getSideChat(stale.id)).toBeUndefined();
    expect(getSideChat(fresh.id)).toBe(fresh);
  });
});
