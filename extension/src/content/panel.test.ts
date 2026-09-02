import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPanel } from "./panel";

/**
 * Regression cover for a real bug report: typing into the panel's input
 * bounced focus back to the host page's own chat composer. Host pages like
 * claude.ai/chatgpt.com often have a "type anywhere refocuses my input"
 * global listener, and because the panel lives in a shadow tree, an
 * event.target read from outside the shadow boundary retargets to the shadow
 * host (a plain div) — so a host page's "skip if already in an input" check
 * never recognizes ours and steals focus back.
 */
beforeEach(() => {
  document.body.innerHTML = "";
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ text: () => Promise.resolve("") }),
  );
});

const ctx = { selectedText: "timeslice", parentUserMessage: "u", parentAiResponse: "a" };

function openPanelInput() {
  const panel = createPanel({ onSubmit: vi.fn() });
  panel.open(ctx);
  const host = document.getElementById("sidechats-root")!;
  const input = host.shadowRoot!.querySelector(".sidechats-input") as HTMLTextAreaElement;
  return { panel, host, input };
}

describe("panel focus containment", () => {
  it("does not let keydown/click events bubble past the shadow host", () => {
    const { input } = openPanelInput();

    const bodyListener = vi.fn();
    document.body.addEventListener("keydown", bodyListener);
    document.body.addEventListener("click", bodyListener);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, composed: true }));
    input.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

    expect(bodyListener).not.toHaveBeenCalled();
  });

  it("reclaims focus if something outside the panel steals it while still open", async () => {
    const { host, input } = openPanelInput();
    const outsideInput = document.createElement("input");
    document.body.appendChild(outsideInput);

    input.focus();
    // No mousedown precedes this — simulates a host script calling .focus()
    // programmatically (e.g. from its own keydown handler), not a real click.
    outsideInput.focus();

    await Promise.resolve();
    await Promise.resolve();

    expect(host.shadowRoot!.activeElement).toBe(input);
  });

  it("does not reclaim focus after a deliberate click elsewhere on the page", async () => {
    const { input } = openPanelInput();
    const outsideInput = document.createElement("input");
    document.body.appendChild(outsideInput);

    input.focus();
    outsideInput.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    outsideInput.focus();

    await Promise.resolve();
    await Promise.resolve();

    expect(document.activeElement).toBe(outsideInput);
  });

  it("does not fight focus moving within the panel itself (e.g. to Send)", async () => {
    const { host, input } = openPanelInput();
    const sendBtn = host.shadowRoot!.querySelector(".sidechats-send") as HTMLButtonElement;

    input.focus();
    sendBtn.focus();

    await Promise.resolve();
    await Promise.resolve();

    expect(host.shadowRoot!.activeElement).toBe(sendBtn);
  });

  it("does not reclaim focus once the panel has been closed", async () => {
    const { panel, input } = openPanelInput();
    const outsideInput = document.createElement("input");
    document.body.appendChild(outsideInput);

    input.focus();
    panel.close();
    outsideInput.focus();

    await Promise.resolve();
    await Promise.resolve();

    expect(document.activeElement).toBe(outsideInput);
  });
});
