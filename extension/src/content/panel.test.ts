import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageAttachment } from "../shared/types";
import { MAX_IMAGES_PER_MESSAGE } from "../shared/image";
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
  // jsdom has no codec, and none of these tests are about one. The stub reports
  // fixed dimensions so `processImage` takes its pass-through path (already
  // small enough, already a supported type) and the composer gets a real
  // ImageAttachment back without OffscreenCanvas ever being needed.
  vi.stubGlobal("createImageBitmap", async () => ({ width: 800, height: 600, close: () => {} }));
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

/* ---------------------------------------------------------------------------
 * Composer: staging images and sending them.
 *
 * jsdom implements neither DataTransfer, ClipboardEvent nor DragEvent, so the
 * paste and drop events below are hand-built with just the surface panel.ts
 * actually reads. That is a real limitation of these tests — they prove the
 * composer's logic, not that a browser hands it what it expects — which is why
 * the plan puts a real-Chromium drag in `check:browser` on top.
 * ------------------------------------------------------------------------ */

function imageFile(type = "image/png", bytes = 32): File {
  return new File([new Uint8Array(bytes)], "shot.png", { type });
}

function attachment(overrides: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    id: "img-1",
    mediaType: "image/png",
    data: "aGVsbG8=",
    width: 20,
    height: 10,
    byteSize: 5,
    ...overrides,
  };
}

function pasteEvent(items: Array<{ kind: string; type: string; file?: File }>): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: items.map((item) => ({
        kind: item.kind,
        type: item.type,
        getAsFile: () => item.file ?? null,
      })),
    },
  });
  return event;
}

function dropEvent(files: File[]): Event {
  const event = new Event("drop", { bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files } });
  return event;
}

function openComposer(onSubmit = vi.fn().mockResolvedValue({ reply: "an answer" })) {
  const panel = createPanel({ onSubmit });
  panel.open(ctx);
  const root = document.getElementById("sidechats-root")!.shadowRoot!;
  return {
    panel,
    onSubmit,
    root,
    input: root.querySelector(".sidechats-input") as HTMLTextAreaElement,
    sendBtn: root.querySelector(".sidechats-send") as HTMLButtonElement,
    panelEl: root.querySelector(".sidechats-panel") as HTMLDivElement,
    tray: root.querySelector(".sidechats-tray") as HTMLDivElement,
    chips: () => Array.from(root.querySelectorAll(".sidechats-chip")),
    bodyText: () => (root.querySelector(".sidechats-body") as HTMLElement).textContent ?? "",
  };
}

describe("composer image staging", () => {
  it("stages a pasted image as a tray chip", async () => {
    const { input, tray, chips } = openComposer();

    expect(tray.hidden).toBe(true);
    input.dispatchEvent(pasteEvent([{ kind: "file", type: "image/png", file: imageFile() }]));

    await vi.waitFor(() => expect(chips()).toHaveLength(1));
    expect(tray.hidden).toBe(false);
    const thumb = chips()[0].querySelector("img") as HTMLImageElement;
    expect(thumb.src.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("leaves a plain-text paste alone", async () => {
    const { input, chips } = openComposer();

    const event = pasteEvent([{ kind: "string", type: "text/plain" }]);
    input.dispatchEvent(event);

    await Promise.resolve();
    expect(event.defaultPrevented).toBe(false);
    expect(chips()).toHaveLength(0);
  });

  it("removes a chip with its × and re-hides the empty tray", async () => {
    const { input, tray, chips } = openComposer();

    input.dispatchEvent(pasteEvent([{ kind: "file", type: "image/png", file: imageFile() }]));
    await vi.waitFor(() => expect(chips()).toHaveLength(1));

    (chips()[0].querySelector(".sidechats-chip-remove") as HTMLButtonElement).click();

    expect(chips()).toHaveLength(0);
    expect(tray.hidden).toBe(true);
  });

  it("stages an image dropped on the panel", async () => {
    const { panelEl, chips } = openComposer();

    panelEl.dispatchEvent(dropEvent([imageFile()]));

    await vi.waitFor(() => expect(chips()).toHaveLength(1));
  });

  it("stages images chosen through the file picker", async () => {
    const { root, chips } = openComposer();
    const fileInput = root.querySelector(".sidechats-file-input") as HTMLInputElement;

    Object.defineProperty(fileInput, "files", { value: [imageFile()], configurable: true });
    fileInput.dispatchEvent(new Event("change"));

    await vi.waitFor(() => expect(chips()).toHaveLength(1));
  });

  it("renders an image handed to addImage — the region-capture entry point", () => {
    const { panel, chips, tray } = openComposer();

    panel.addImage(attachment());

    expect(chips()).toHaveLength(1);
    expect(tray.hidden).toBe(false);
  });

  it("stops staging once the extension context is gone", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("Extension context invalidated."));
    const { panel, input, sendBtn, chips } = openComposer(onSubmit);

    input.value = "anything";
    sendBtn.click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());

    panel.addImage(attachment());

    // Nothing staged now could ever be sent — the panel is already showing the
    // reload wall, and a chip would only invite another doomed send.
    expect(chips()).toHaveLength(0);
  });

  it("refuses more than the per-message limit and says so", () => {
    const { panel, chips, bodyText } = openComposer();

    for (let i = 0; i <= MAX_IMAGES_PER_MESSAGE; i++) {
      panel.addImage(attachment({ id: `img-${i}` }));
    }

    expect(chips()).toHaveLength(MAX_IMAGES_PER_MESSAGE);
    expect(bodyText()).toContain(`up to ${MAX_IMAGES_PER_MESSAGE} images`);
  });
});

describe("composer submit with images", () => {
  it("sends an image with no question at all", async () => {
    const { panel, onSubmit, sendBtn } = openComposer();
    const image = attachment();
    panel.addImage(image);

    sendBtn.click();

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toBe("");
    expect(onSubmit.mock.calls[0][2]).toEqual([image]);
  });

  it("still refuses a submit with neither text nor images", async () => {
    const { onSubmit, sendBtn } = openComposer();

    sendBtn.click();
    await Promise.resolve();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clears the tray as the message goes out", async () => {
    const { panel, onSubmit, input, sendBtn, tray, chips } = openComposer();
    panel.addImage(attachment());
    input.value = "what is this?";

    sendBtn.click();

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(chips()).toHaveLength(0);
    expect(tray.hidden).toBe(true);
  });

  it("shows the sent image in the user's own bubble, above the question", async () => {
    const { panel, onSubmit, input, sendBtn, root } = openComposer();
    panel.addImage(attachment());
    input.value = "what is this?";

    sendBtn.click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());

    const bubble = root.querySelector(".sidechats-bubble--user") as HTMLElement;
    const img = bubble.querySelector("img") as HTMLImageElement;
    expect(img.src).toBe("data:image/png;base64,aGVsbG8=");
    expect(bubble.textContent).toContain("what is this?");
    expect(bubble.firstElementChild?.className).toBe("sidechats-bubble-images");
  });
});

describe("panel header for a captured region", () => {
  it("shows the screenshot in the excerpt's place when nothing was selected", () => {
    const panel = createPanel({ onSubmit: vi.fn() });
    panel.open({
      selectedText: "",
      parentUserMessage: "u",
      parentAiResponse: "a",
      screenshot: attachment(),
    });
    const root = document.getElementById("sidechats-root")!.shadowRoot!;

    const thumb = root.querySelector(".sidechats-header-thumb") as HTMLImageElement;
    expect(thumb).not.toBeNull();
    expect(thumb.src).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("keeps the text excerpt when there is one, screenshot or not", () => {
    const panel = createPanel({ onSubmit: vi.fn() });
    panel.open({ ...ctx, screenshot: attachment() });
    const root = document.getElementById("sidechats-root")!.shadowRoot!;

    expect(root.querySelector(".sidechats-header-thumb")).toBeNull();
    expect(root.querySelector(".sidechats-header-preview")!.textContent).toBe("timeslice");
  });
});
