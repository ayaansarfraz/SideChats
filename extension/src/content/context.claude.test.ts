import { beforeEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "./adapters/claude";
import { collectTurns, extractContext } from "./context";
import {
  claudeConversation,
  legacyClaudeConversation,
  type FixtureTurn,
} from "./__fixtures__/claude";
import {
  selectAcross,
  selectAcrossBackwards,
  selectNothing,
  selectText,
} from "./__fixtures__/selection";

const CONVERSATION: FixtureTurn[] = [
  { role: "user", html: "<p>What is a perfect matching?</p>" },
  {
    role: "assistant",
    html: "<p>A perfect matching pairs up every vertex exactly once.</p>",
  },
  { role: "user", html: "<p>Why does every tree have at most one?</p>" },
  {
    role: "assistant",
    html:
      "<p>Take the symmetric difference of two matchings.</p>" +
      '<pre><div class="code-header"><span>python</span>' +
      '<button type="button">Copy</button></div>' +
      "<code>def match(tree): ...</code></pre>",
  },
];

/** Normalise away the whitespace the fixture's indentation introduces. */
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function render(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe("claude.ai context extraction", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("finds every turn exactly once despite nested matching wrappers", () => {
    const root = render(claudeConversation(CONVERSATION));
    const turns = collectTurns(claudeAdapter, root);

    // An assistant turn matches both `[data-is-streaming]` and the
    // `.font-claude-response` inside it. If both were kept, the turn would be
    // counted twice and every backwards walk would land one turn short.
    expect(turns).toHaveLength(4);
    expect(turns.map((t) => claudeAdapter.roleOf(t))).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("extracts the selection, its parent turn pair, and prior context", () => {
    const root = render(claudeConversation(CONVERSATION));
    const selection = selectText(root, "symmetric difference");

    const ctx = extractContext(selection, claudeAdapter, root);

    expect(ctx).not.toBeNull();
    expect(ctx!.selectedText).toBe("symmetric difference");
    expect(squash(ctx!.parentUserMessage)).toBe("Why does every tree have at most one?");
    expect(squash(ctx!.parentAiResponse)).toContain("Take the symmetric difference");
    expect(squash(ctx!.priorContext ?? "")).toContain("User: What is a perfect matching?");
    expect(squash(ctx!.priorContext ?? "")).toContain(
      "Assistant: A perfect matching pairs up every vertex exactly once.",
    );
  });

  it("strips code-block and action-bar chrome out of the extracted text", () => {
    const root = render(claudeConversation(CONVERSATION));
    const selection = selectText(root, "symmetric difference");

    const ctx = extractContext(selection, claudeAdapter, root)!;

    // "Copy" and "Retry" are buttons in the message, not part of the answer.
    expect(ctx.parentAiResponse).not.toContain("Copy");
    expect(ctx.parentAiResponse).not.toContain("Retry");
    // The code itself is part of the answer and must survive.
    expect(squash(ctx.parentAiResponse)).toContain("def match(tree)");
    // Stripping happens on a clone; the live page keeps its buttons.
    expect(root.querySelectorAll("button").length).toBeGreaterThan(0);
  });

  it("omits priorContext when the parent pair is the start of the conversation", () => {
    const root = render(claudeConversation(CONVERSATION.slice(0, 2)));
    const selection = selectText(root, "pairs up every vertex");

    const ctx = extractContext(selection, claudeAdapter, root)!;

    expect(squash(ctx.parentUserMessage)).toBe("What is a perfect matching?");
    expect(ctx.priorContext).toBeUndefined();
  });

  it("still extracts when the assistant turn has no preceding user turn", () => {
    const root = render(claudeConversation([CONVERSATION[1]]));
    const selection = selectText(root, "pairs up every vertex");

    const ctx = extractContext(selection, claudeAdapter, root)!;

    expect(ctx.parentUserMessage).toBe("");
    expect(ctx.priorContext).toBeUndefined();
  });

  it("resolves a drag across a paragraph and a code block in either direction", () => {
    const root = render(claudeConversation(CONVERSATION));

    const forwards = extractContext(
      selectAcross(root, "symmetric difference", "def match(tree)"),
      claudeAdapter,
      root,
    );
    const backwards = extractContext(
      selectAcrossBackwards(root, "symmetric difference", "def match(tree)"),
      claudeAdapter,
      root,
    );

    // Both endpoints are inside the same assistant turn, so which end the
    // anchor is on must not change the answer.
    expect(forwards).not.toBeNull();
    expect(forwards!.selectedText).toContain("def match(tree)");
    expect(backwards).toEqual(forwards);
  });

  it("falls back to the other endpoint when the drag starts outside any turn", () => {
    const root = render(claudeConversation(CONVERSATION));
    // Anchored in the sidebar, released inside the answer — the anchor is in no
    // turn at all, so extraction has to look at the far end of the selection.
    const selection = selectAcross(root, "Recent chats live out here", "symmetric difference");

    const ctx = extractContext(selection, claudeAdapter, root);

    expect(ctx).not.toBeNull();
    expect(squash(ctx!.parentUserMessage)).toBe("Why does every tree have at most one?");
  });

  it("falls back to the older font-claude-message markup", () => {
    const root = render(legacyClaudeConversation(CONVERSATION));
    const selection = selectText(root, "symmetric difference");

    const ctx = extractContext(selection, claudeAdapter, root);

    expect(ctx).not.toBeNull();
    expect(squash(ctx!.parentUserMessage)).toBe("Why does every tree have at most one?");
  });

  describe("selections that are not askable", () => {
    it("returns null inside the user's own message", () => {
      const root = render(claudeConversation(CONVERSATION));
      const selection = selectText(root, "at most one");
      expect(extractContext(selection, claudeAdapter, root)).toBeNull();
    });

    it("returns null outside the conversation", () => {
      const root = render(claudeConversation(CONVERSATION));
      const selection = selectText(root, "Recent chats live out here");
      expect(extractContext(selection, claudeAdapter, root)).toBeNull();
    });

    it("returns null for an empty selection", () => {
      const root = render(claudeConversation(CONVERSATION));
      expect(extractContext(selectNothing(document), claudeAdapter, root)).toBeNull();
    });

    it("returns null when a selection starting in a user turn spans into the reply", () => {
      const root = render(claudeConversation(CONVERSATION));
      const selection = selectAcross(root, "Why does every tree", "symmetric difference");
      // Matches the ChatGPT behaviour: a selection that begins in the user's
      // own message is not a branch point, even if it runs into the answer.
      expect(extractContext(selection, claudeAdapter, root)).toBeNull();
    });

    it("returns null when the page has no conversation at all", () => {
      const root = render("<main><p>New chat</p></main>");
      const selection = selectText(root, "New chat");
      expect(extractContext(selection, claudeAdapter, root)).toBeNull();
    });
  });
});
