// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { getSelectionContext } from "./context";
import {
  clearFixtures,
  renderChatGptTurns,
  renderDetachedTurn,
  textNodeOf,
} from "./__fixtures__/chatgpt";

/**
 * Real Selection/Range APIs are notoriously unreliable in jsdom, so these
 * tests duck-type a Selection: getSelectionContext only reads
 * `.rangeCount`, `.toString()`, and `.anchorNode`.
 */
function fakeSelection(text: string, anchorNode: Node | null, rangeCount = 1): Selection {
  return { rangeCount, toString: () => text, anchorNode } as unknown as Selection;
}

afterEach(() => {
  clearFixtures();
});

describe("getSelectionContext", () => {
  it("returns null when there is no selection", () => {
    expect(getSelectionContext(null as unknown as Selection)).toBeNull();
  });

  it("returns null when rangeCount is 0", () => {
    expect(getSelectionContext(fakeSelection("timeslice", null, 0))).toBeNull();
  });

  it("returns null for an empty or whitespace-only selection", () => {
    expect(getSelectionContext(fakeSelection("   ", null))).toBeNull();
  });

  it("returns null when anchorNode is missing", () => {
    expect(getSelectionContext(fakeSelection("timeslice", null))).toBeNull();
  });

  it("returns null when the selection is outside any message turn", () => {
    const outside = document.createElement("p");
    outside.textContent = "just page chrome, not a turn";
    document.body.appendChild(outside);

    const ctx = getSelectionContext(fakeSelection("page chrome", outside.firstChild));
    expect(ctx).toBeNull();
    outside.remove();
  });

  it("returns null when the selection is inside a user turn, not an assistant turn", () => {
    const [userTurn] = renderChatGptTurns([{ role: "user", text: "Explain the OS scheduler." }]);
    const ctx = getSelectionContext(fakeSelection("scheduler", textNodeOf(userTurn)));
    expect(ctx).toBeNull();
  });

  it("extracts selectedText, parentUserMessage, and parentAiResponse for a normal selection", () => {
    const [, assistantTurn] = renderChatGptTurns([
      { role: "user", text: "Explain the OS scheduler." },
      { role: "assistant", text: "The kernel context-switches after a timeslice." },
    ]);

    const ctx = getSelectionContext(fakeSelection("timeslice", textNodeOf(assistantTurn)));

    expect(ctx).toEqual({
      selectedText: "timeslice",
      parentUserMessage: "Explain the OS scheduler.",
      parentAiResponse: "The kernel context-switches after a timeslice.",
    });
  });

  it("parentUserMessage is empty when there is no preceding user turn", () => {
    const [assistantTurn] = renderChatGptTurns([
      { role: "assistant", text: "Hi, how can I help?" },
    ]);

    const ctx = getSelectionContext(fakeSelection("help", textNodeOf(assistantTurn)));

    expect(ctx?.parentUserMessage).toBe("");
    expect(ctx?.priorContext).toBeUndefined();
  });

  it("includes priorContext when an earlier user/assistant pair exists", () => {
    const [, , , assistantTurn2] = renderChatGptTurns([
      { role: "user", text: "Explain the OS scheduler." },
      { role: "assistant", text: "The kernel context-switches after a timeslice." },
      { role: "user", text: "Why does that matter?" },
      { role: "assistant", text: "It keeps CPU access fair across threads." },
    ]);

    const ctx = getSelectionContext(fakeSelection("fair", textNodeOf(assistantTurn2)));

    expect(ctx?.parentUserMessage).toBe("Why does that matter?");
    expect(ctx?.priorContext).toBe(
      "User: Explain the OS scheduler.\n\nAssistant: The kernel context-switches after a timeslice.",
    );
  });

  it("does not throw, and yields an empty parentUserMessage, when the assistant turn is detached from the document (assistantIndex === -1 fallback)", () => {
    const detached = renderDetachedTurn({
      role: "assistant",
      text: "This turn was never attached to document.body.",
    });

    let ctx: ReturnType<typeof getSelectionContext>;
    expect(() => {
      ctx = getSelectionContext(fakeSelection("never attached", textNodeOf(detached)));
    }).not.toThrow();

    expect(ctx!.parentAiResponse).toBe("This turn was never attached to document.body.");
    expect(ctx!.parentUserMessage).toBe("");
  });
});
