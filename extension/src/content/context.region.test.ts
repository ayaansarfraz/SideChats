import { afterEach, describe, expect, it } from "vitest";
import { chatgptAdapter } from "./adapters/chatgpt";
import { elementUnderRegion, extractRegionContext, getRegionContext } from "./context";
import { renderChatGptTurns, renderOutsideText } from "./__fixtures__/chatgpt";
import type { ImageAttachment } from "../shared/types";

/**
 * The second way into a side chat: the user drags a box instead of selecting
 * words. `extractRegionContext` takes the element the box landed on — resolved
 * by `elementUnderRegion` against real layout, which jsdom does not have — so
 * these drive it with the element directly, the same split
 * `extractContext`/`getSelectionContext` already uses.
 */
const screenshot: ImageAttachment = {
  id: "shot-1",
  mediaType: "image/png",
  data: "aGk=",
  width: 320,
  height: 180,
  byteSize: 2,
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("extractRegionContext", () => {
  it("carries the screenshot as the branch point, with no selected text", () => {
    const [, assistant] = renderChatGptTurns([
      { role: "user", text: "Chart the results." },
      { role: "assistant", text: "Here is the chart." },
    ]);

    const ctx = extractRegionContext(assistant, screenshot, chatgptAdapter, document.body);

    expect(ctx.selectedText).toBe("");
    expect(ctx.screenshot).toEqual(screenshot);
  });

  it("picks up the surrounding turns when the region lands in an answer", () => {
    const [, , , assistant] = renderChatGptTurns([
      { role: "user", text: "What is a matching?" },
      { role: "assistant", text: "A set of disjoint edges." },
      { role: "user", text: "Chart the results." },
      { role: "assistant", text: "Here is the chart." },
    ]);

    const ctx = extractRegionContext(assistant, screenshot, chatgptAdapter, document.body);

    expect(ctx.parentAiResponse).toBe("Here is the chart.");
    expect(ctx.parentUserMessage).toBe("Chart the results.");
    expect(ctx.priorContext).toBe(
      "User: What is a matching?\n\nAssistant: A set of disjoint edges.",
    );
  });

  it("finds the turn from a node deep inside it, not just the turn element", () => {
    const [, assistant] = renderChatGptTurns([
      { role: "user", text: "Chart the results." },
      { role: "assistant", text: "Here is the chart." },
    ]);
    const paragraph = assistant.querySelector("p");

    const ctx = extractRegionContext(paragraph, screenshot, chatgptAdapter, document.body);

    expect(ctx.parentAiResponse).toBe("Here is the chart.");
  });

  /**
   * A selection in the user's own message is not askable — there is nothing to
   * branch off. A *region* there is: people paste images into their own turns,
   * and that picture is exactly the kind of thing this feature exists for. So
   * it keeps the message and leaves the response empty rather than refusing.
   */
  it("keeps the user's own message when the region lands in a user turn", () => {
    const [user] = renderChatGptTurns([
      { role: "user", text: "Here's the screenshot I mentioned." },
      { role: "assistant", text: "Thanks, I see it." },
    ]);

    const ctx = extractRegionContext(user, screenshot, chatgptAdapter, document.body);

    expect(ctx.parentUserMessage).toBe("Here's the screenshot I mentioned.");
    expect(ctx.parentAiResponse).toBe("");
    expect(ctx.screenshot).toEqual(screenshot);
  });

  it("still returns a package when the region is outside the conversation", () => {
    renderChatGptTurns([{ role: "assistant", text: "Here is the chart." }]);
    const furniture = renderOutsideText("Sidebar");

    const ctx = extractRegionContext(furniture, screenshot, chatgptAdapter, document.body);

    expect(ctx).toEqual({
      selectedText: "",
      parentUserMessage: "",
      parentAiResponse: "",
      screenshot,
    });
  });

  it("still returns a package when nothing resolved under the region at all", () => {
    renderChatGptTurns([{ role: "assistant", text: "Here is the chart." }]);

    const ctx = extractRegionContext(null, screenshot, chatgptAdapter, document.body);

    expect(ctx.screenshot).toEqual(screenshot);
    expect(ctx.parentAiResponse).toBe("");
  });
});

describe("elementUnderRegion", () => {
  it("probes the centre of the region", () => {
    const seen: Array<[number, number]> = [];
    const doc = {
      documentElement: { clientWidth: 1000, clientHeight: 800 },
      elementFromPoint: (x: number, y: number) => {
        seen.push([x, y]);
        return null;
      },
    } as unknown as Document;

    elementUnderRegion({ x: 100, y: 200, width: 200, height: 100 }, doc);

    expect(seen).toEqual([[200, 250]]);
  });

  it("clamps the probe into the viewport for a region that ran off the edge", () => {
    const seen: Array<[number, number]> = [];
    const doc = {
      documentElement: { clientWidth: 400, clientHeight: 300 },
      elementFromPoint: (x: number, y: number) => {
        seen.push([x, y]);
        return null;
      },
    } as unknown as Document;

    elementUnderRegion({ x: 380, y: 280, width: 200, height: 200 }, doc);

    expect(seen).toEqual([[399, 299]]);
  });

  it("degrades to null where elementFromPoint is unavailable (jsdom)", () => {
    expect(elementUnderRegion({ x: 0, y: 0, width: 10, height: 10 })).toBeNull();
  });
});

describe("getRegionContext", () => {
  // vitest.config.ts pins jsdom's URL to chatgpt.com, so the adapter resolves.
  it("reads the live document through the host's adapter", () => {
    const [, assistant] = renderChatGptTurns([
      { role: "user", text: "Chart the results." },
      { role: "assistant", text: "Here is the chart." },
    ]);

    const ctx = getRegionContext(screenshot, assistant);

    expect(ctx.parentAiResponse).toBe("Here is the chart.");
    expect(ctx.screenshot).toEqual(screenshot);
  });
});
