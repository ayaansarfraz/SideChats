import { afterEach, describe, expect, it } from "vitest";
import { chatgptAdapter } from "./adapters/chatgpt";
import { extractContext, getSelectionContext } from "./context";
import {
  selectAcross,
  selectAcrossBackwards,
  selectNothing,
  selectText,
} from "./__fixtures__/selection";
import { renderChatGptTurns, renderDetachedTurn, renderOutsideText, textNodeOf } from "./__fixtures__/chatgpt";

/**
 * The broad ChatGPT edge-case suite (see context.chatgpt-parity.test.ts for
 * the narrower refactor-parity net). Drives real Selection/Range objects via
 * the shared __fixtures__/selection helpers rather than stand-ins, except for
 * the one case a real Selection genuinely cannot express: a turn detached
 * from the document (context.chatgpt-parity.test.ts hits the same wall the
 * same way).
 */
afterEach(() => {
  document.body.innerHTML = "";
});

describe("extractContext (chatgpt)", () => {
  it("returns null when there is no selection", () => {
    expect(extractContext(null as unknown as Selection, chatgptAdapter, document.body)).toBeNull();
  });

  it("returns null for a collapsed (empty) selection", () => {
    const selection = selectNothing(document);
    expect(extractContext(selection, chatgptAdapter, document.body)).toBeNull();
  });

  it("returns null for a whitespace-only selection", () => {
    renderChatGptTurns([{ role: "assistant", text: "   " }]);
    const selection = selectText(document.body, "   ");
    expect(extractContext(selection, chatgptAdapter, document.body)).toBeNull();
  });

  it("returns null when the selection is outside any message turn", () => {
    renderOutsideText("just page chrome, not a turn");
    const selection = selectText(document.body, "page chrome");
    expect(extractContext(selection, chatgptAdapter, document.body)).toBeNull();
  });

  it("returns null when the selection is inside a user turn, not an assistant turn", () => {
    renderChatGptTurns([{ role: "user", text: "Explain the OS scheduler." }]);
    const selection = selectText(document.body, "scheduler");
    expect(extractContext(selection, chatgptAdapter, document.body)).toBeNull();
  });

  it("extracts selectedText, parentUserMessage, and parentAiResponse for a normal selection", () => {
    renderChatGptTurns([
      { role: "user", text: "Explain the OS scheduler." },
      { role: "assistant", text: "The kernel context-switches after a timeslice." },
    ]);

    const selection = selectText(document.body, "timeslice");
    const ctx = extractContext(selection, chatgptAdapter, document.body);

    expect(ctx).toEqual({
      selectedText: "timeslice",
      parentUserMessage: "Explain the OS scheduler.",
      parentAiResponse: "The kernel context-switches after a timeslice.",
    });
  });

  it("parentUserMessage is empty when there is no preceding user turn", () => {
    renderChatGptTurns([{ role: "assistant", text: "Hi, how can I help?" }]);

    const selection = selectText(document.body, "help");
    const ctx = extractContext(selection, chatgptAdapter, document.body);

    expect(ctx?.parentUserMessage).toBe("");
    expect(ctx?.priorContext).toBeUndefined();
  });

  it("includes priorContext when an earlier user/assistant pair exists", () => {
    renderChatGptTurns([
      { role: "user", text: "Explain the OS scheduler." },
      { role: "assistant", text: "The kernel context-switches after a timeslice." },
      { role: "user", text: "Why does that matter?" },
      { role: "assistant", text: "It keeps CPU access fair across threads." },
    ]);

    const selection = selectText(document.body, "fair");
    const ctx = extractContext(selection, chatgptAdapter, document.body);

    expect(ctx?.parentUserMessage).toBe("Why does that matter?");
    expect(ctx?.priorContext).toBe(
      "User: Explain the OS scheduler.\n\nAssistant: The kernel context-switches after a timeslice.",
    );
  });

  it("returns null when a forward drag starts in the user's message, even if it runs into the reply", () => {
    renderChatGptTurns([
      { role: "user", text: "Explain the OS scheduler." },
      { role: "assistant", text: "The kernel context-switches after a timeslice." },
    ]);

    // anchorNode lands in the user turn, focusNode in the assistant turn —
    // the anchor decides, so this is still not askable.
    const selection = selectAcross(
      document.body,
      "Explain the OS scheduler.",
      "The kernel context-switches after a timeslice.",
    );

    expect(extractContext(selection, chatgptAdapter, document.body)).toBeNull();
  });

  it("attributes a backward drag to the turn the anchor actually landed in", () => {
    renderChatGptTurns([
      { role: "user", text: "Explain the OS scheduler." },
      { role: "assistant", text: "The kernel context-switches after a timeslice." },
    ]);

    // Same span as above, dragged the other direction: anchorNode now lands
    // in the assistant turn, focusNode in the user turn.
    const selection = selectAcrossBackwards(
      document.body,
      "Explain the OS scheduler.",
      "The kernel context-switches after a timeslice.",
    );

    const ctx = extractContext(selection, chatgptAdapter, document.body);
    expect(ctx?.parentAiResponse).toBe("The kernel context-switches after a timeslice.");
  });

  it("falls back to focusNode when the anchor lands outside every turn", () => {
    renderOutsideText("some margin text");
    renderChatGptTurns([{ role: "assistant", text: "It ensures fairness across threads." }]);

    // anchorNode is in page furniture (no turn contains it); focusNode is in
    // the assistant turn, so resolution falls back to it.
    const selection = selectAcross(document.body, "margin text", "fairness across threads");

    const ctx = extractContext(selection, chatgptAdapter, document.body);
    expect(ctx?.parentAiResponse).toBe("It ensures fairness across threads.");
  });

  it("does not throw, and yields an empty parentUserMessage, when the assistant turn is detached from the document", () => {
    // A real Selection cannot address a node outside the document at all, so
    // this one case is duck-typed — the same thing context.chatgpt-parity.test.ts
    // does for the identical scenario.
    const detached = renderDetachedTurn({
      role: "assistant",
      text: "This turn was never attached to document.body.",
    });
    const textNode = textNodeOf(detached);
    const selection = {
      rangeCount: 1,
      toString: () => "never attached",
      anchorNode: textNode,
      focusNode: textNode,
    } as unknown as Selection;

    let ctx: ReturnType<typeof extractContext>;
    expect(() => {
      ctx = extractContext(selection, chatgptAdapter, document.body);
    }).not.toThrow();

    expect(ctx!.parentAiResponse).toBe("This turn was never attached to document.body.");
    expect(ctx!.parentUserMessage).toBe("");
  });
});

describe("getSelectionContext (chatgpt)", () => {
  it("resolves the chatgpt adapter from window.location.hostname (pinned to chatgpt.com in vitest.config.ts)", () => {
    renderChatGptTurns([{ role: "assistant", text: "The kernel context-switches after a timeslice." }]);
    const selection = selectText(document.body, "timeslice");
    expect(getSelectionContext(selection)?.selectedText).toBe("timeslice");
  });
});
