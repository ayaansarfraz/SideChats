import { beforeEach, describe, expect, it } from "vitest";
import { chatgptAdapter } from "./adapters/chatgpt";
import { collectTurns, extractContext } from "./context";
import { selectText } from "./__fixtures__/selection";

/**
 * Parity cover for the adapter refactor.
 *
 * Moving ChatGPT's `data-message-author-role` handling behind the SiteAdapter
 * interface was meant to be a pure refactor, so these tests pin the ChatGPT
 * behaviour that existed before it. They deliberately keep their markup inline
 * and their scope narrow — the broader ChatGPT edge-case suite lives in
 * context.test.ts and is owned by another lane.
 */
const CHATGPT_HTML = `
  <main>
    <article data-testid="conversation-turn-1">
      <div class="flex flex-col">
        <div data-message-author-role="user" data-message-id="m1">
          <div class="whitespace-pre-wrap">What is a perfect matching?</div>
        </div>
      </div>
    </article>
    <article data-testid="conversation-turn-2">
      <div class="flex flex-col">
        <div data-message-author-role="assistant" data-message-id="m2">
          <div class="markdown prose"><p>It pairs up every vertex exactly once.</p></div>
        </div>
      </div>
    </article>
    <article data-testid="conversation-turn-3">
      <div class="flex flex-col">
        <div data-message-author-role="user" data-message-id="m3">
          <div class="whitespace-pre-wrap">Why does every tree have at most one?</div>
        </div>
      </div>
    </article>
    <article data-testid="conversation-turn-4">
      <div class="flex flex-col">
        <div data-message-author-role="assistant" data-message-id="m4">
          <div class="markdown prose">
            <p>Take the symmetric difference of two matchings.</p>
            <pre><div class="contain-inline-size"><span>python</span>
              <button type="button">Copy code</button></div><code>def match(tree): ...</code></pre>
          </div>
        </div>
      </div>
    </article>
  </main>`;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("chatgpt extraction is unchanged by the adapter refactor", () => {
  beforeEach(() => {
    document.body.innerHTML = CHATGPT_HTML;
  });

  it("finds one turn per message", () => {
    const turns = collectTurns(chatgptAdapter, document.body);
    expect(turns.map((t) => chatgptAdapter.roleOf(t))).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("extracts the selection, its parent pair, and prior context", () => {
    const selection = selectText(document.body, "symmetric difference");

    const ctx = extractContext(selection, chatgptAdapter, document.body)!;

    expect(ctx.selectedText).toBe("symmetric difference");
    expect(squash(ctx.parentUserMessage)).toBe("Why does every tree have at most one?");
    expect(squash(ctx.parentAiResponse)).toContain("Take the symmetric difference");
    expect(squash(ctx.priorContext ?? "")).toBe(
      "User: What is a perfect matching? Assistant: It pairs up every vertex exactly once.",
    );
  });

  it("returns null for a selection in the user's own message", () => {
    const selection = selectText(document.body, "at most one");
    expect(extractContext(selection, chatgptAdapter, document.body)).toBeNull();
  });

  it("drops the code block's copy control from the extracted response", () => {
    const selection = selectText(document.body, "symmetric difference");

    const ctx = extractContext(selection, chatgptAdapter, document.body)!;

    // New behaviour, and the one thing here that is not pure parity: "Copy
    // code" used to land in the middle of the response text sent to the model.
    expect(ctx.parentAiResponse).not.toContain("Copy code");
    expect(squash(ctx.parentAiResponse)).toContain("def match(tree)");
  });
});
