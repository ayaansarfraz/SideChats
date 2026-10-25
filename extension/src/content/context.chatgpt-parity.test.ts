import { beforeEach, describe, expect, it } from "vitest";
import { chatgptAdapter } from "./adapters/chatgpt";
import { collectTurns, extractContext, getSelectionContext } from "./context";
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

  it("still extracts from a turn detached from the document", () => {
    // A mid-stream React re-render can drop the turn out of the document
    // between the drag and the click. The turn has no neighbours to walk to,
    // but its own text is still worth branching from, so this must not go null.
    const detached = document.createElement("div");
    detached.setAttribute("data-message-author-role", "assistant");
    detached.innerHTML = "<div class='markdown'><p>This turn was never attached.</p></div>";
    const textNode = detached.querySelector("p")!.firstChild!;

    const selection = {
      rangeCount: 1,
      toString: () => "never attached",
      anchorNode: textNode,
      focusNode: textNode,
    } as unknown as Selection;

    const ctx = extractContext(selection, chatgptAdapter, document.body)!;

    expect(ctx.parentAiResponse).toBe("This turn was never attached.");
    expect(ctx.parentUserMessage).toBe("");
    expect(ctx.priorContext).toBeUndefined();
  });

  it("resolves the adapter from the page's hostname", () => {
    // getSelectionContext reads window.location.hostname, which the vitest
    // config pins to chatgpt.com. This is the wiring the content script uses;
    // the rest of these tests go through extractContext and would not catch it
    // breaking.
    const selection = selectText(document.body, "symmetric difference");
    expect(getSelectionContext(selection)?.selectedText).toBe("symmetric difference");
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

/**
 * Turn-level markup without the message-level role attribute: the article
 * carries `data-turn` and the role element is gone. Matching only
 * `[data-message-author-role]` found zero turns here, so the Ask button never
 * appeared on chatgpt.com.
 */
const CHATGPT_TURN_ONLY_HTML = `
  <main>
    <article data-testid="conversation-turn-1" data-turn="user">
      <h5 class="sr-only">You said:</h5>
      <div class="whitespace-pre-wrap">What is a perfect matching?</div>
    </article>
    <article data-testid="conversation-turn-2" data-turn="assistant">
      <h6 class="sr-only">ChatGPT said:</h6>
      <div class="markdown prose"><p>It pairs up every vertex exactly once.</p></div>
      <div><button type="button">Copy</button></div>
    </article>
  </main>`;

describe("chatgpt turn-level markup", () => {
  beforeEach(() => {
    document.body.innerHTML = CHATGPT_TURN_ONLY_HTML;
  });

  it("finds turns by data-turn when no role attribute is present", () => {
    const turns = collectTurns(chatgptAdapter, document.body);
    expect(turns.map((t) => chatgptAdapter.roleOf(t))).toEqual(["user", "assistant"]);
  });

  it("extracts context with the screen-reader headings and buttons stripped", () => {
    const selection = selectText(document.body, "every vertex");
    const ctx = extractContext(selection, chatgptAdapter, document.body)!;
    expect(ctx).not.toBeNull();
    expect(squash(ctx.parentAiResponse)).toBe("It pairs up every vertex exactly once.");
    expect(squash(ctx.parentUserMessage)).toBe("What is a perfect matching?");
  });

  it("still refuses a selection in the user's own turn", () => {
    const selection = selectText(document.body, "perfect matching");
    expect(extractContext(selection, chatgptAdapter, document.body)).toBeNull();
  });
});

/**
 * The October 2026 markup, as reported from the live page: no article, no role
 * attribute. Each message is a `data-content-search-unit-key` ending in its
 * role, and one `data-turn-key` wraps a question and its answer together.
 */
const UNIT_KEY_HTML = `
  <main>
    <div data-turn-key="t0">
      <div data-content-search-turn-key="fallback-turn-0">
        <div data-content-search-unit-key="fallback-turn-0:0:user"><p>What is a perfect matching?</p></div>
        <div data-talvt-turn-state="complete">
          <div data-content-search-unit-key="fallback-turn-0:1:assistant">
            <div data-markdown-text-style="assistant"><p>It pairs up every vertex exactly once.</p></div>
          </div>
        </div>
      </div>
    </div>
  </main>
`;

describe("chatgpt unit-key markup", () => {
  beforeEach(() => {
    document.body.innerHTML = UNIT_KEY_HTML;
  });

  it("finds the question and the answer as separate turns", () => {
    const turns = collectTurns(chatgptAdapter, document);
    expect(turns.map((t) => chatgptAdapter.roleOf(t))).toEqual(["user", "assistant"]);
  });

  it("extracts context from a selection in the answer", () => {
    const ctx = extractContext(selectText(document, "every vertex"), chatgptAdapter, document);
    expect(ctx?.selectedText).toBe("every vertex");
    expect(ctx?.parentUserMessage).toBe("What is a perfect matching?");
    expect(ctx?.parentAiResponse).toBe("It pairs up every vertex exactly once.");
  });

  it("refuses a selection in the question", () => {
    expect(extractContext(selectText(document, "perfect matching"), chatgptAdapter, document)).toBeNull();
  });
});
