import { afterEach, describe, expect, it } from "vitest";
import { initAskButton } from "./askButton";
import { selectText } from "./__fixtures__/selection";
import type { ContextPackage } from "../shared/types";

const CTX: ContextPackage = {
  selectedText: "every vertex",
  parentUserMessage: "q",
  parentAiResponse: "a",
};

describe("initAskButton", () => {
  afterEach(() => {
    document.getElementById("sidechats-ask-button")?.remove();
    document.body.innerHTML = "";
  });

  it("shows the button even when the page stops mouseup from bubbling", () => {
    document.body.innerHTML = `<div id="turn"><p>It pairs up every vertex exactly once.</p></div>`;
    const turn = document.getElementById("turn")!;
    // What a host page's own selection handling can do to a bubbling listener.
    turn.addEventListener("mouseup", (e) => e.stopPropagation());

    initAskButton(() => CTX, () => {});
    selectText(document.body, "every vertex");
    // jsdom has no layout; give the range a non-zero box so the button shows.
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 10, bottom: 30, left: 10, right: 90, width: 80, height: 20 }) as DOMRect;

    turn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(document.getElementById("sidechats-ask-button")).not.toBeNull();
  });

  it("keeps the button when an inner container scrolls but the selection stays in view", () => {
    document.body.innerHTML = `<div id="turn"><p>It pairs up every vertex exactly once.</p></div>`;
    initAskButton(() => CTX, () => {});
    selectText(document.body, "every vertex");
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 10, bottom: 30, left: 10, right: 90, width: 80, height: 20 }) as DOMRect;
    document.getElementById("turn")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    document.getElementById("turn")!.dispatchEvent(new Event("scroll"));

    expect(document.getElementById("sidechats-ask-button")).not.toBeNull();
  });
});
