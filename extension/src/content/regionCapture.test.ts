// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { initRegionCapture, rectFromDrag } from "./regionCapture";
import { MIN_CAPTURE_EDGE } from "../shared/image";
import type { CaptureRegionRequest } from "../shared/messages";
import type { ContextPackage, ImageAttachment } from "../shared/types";

const HOST_ID = "sidechats-capture-root";

const image: ImageAttachment = {
  id: "img-1",
  mediaType: "image/png",
  data: "aGk=",
  width: 200,
  height: 100,
  byteSize: 2,
};

type CapturedCallback = (image: ImageAttachment, context: ContextPackage) => void;

let sendMessage: Mock<(request: unknown) => Promise<unknown>>;
let panel: {
  hideForCapture: Mock<() => void>;
  showAfterCapture: Mock<() => void>;
  onError: Mock<(message: string) => void>;
};
let onCaptured: Mock<CapturedCallback>;

beforeEach(() => {
  sendMessage = vi.fn<(request: unknown) => Promise<unknown>>();
  sendMessage.mockResolvedValue({ ok: true, kind: "image", image });
  vi.stubGlobal("chrome", { runtime: { id: "test-extension-id", sendMessage } });
  panel = {
    hideForCapture: vi.fn<() => void>(),
    showAfterCapture: vi.fn<() => void>(),
    onError: vi.fn<(message: string) => void>(),
  };
  onCaptured = vi.fn<CapturedCallback>();
});

afterEach(() => {
  document.getElementById(HOST_ID)?.remove();
  document.getElementById("sidechats-ask-button")?.remove();
  vi.unstubAllGlobals();
});

function overlay(): HTMLElement | null {
  return document.getElementById(HOST_ID);
}

function mouse(type: string, x: number, y: number, target: EventTarget = window): void {
  target.dispatchEvent(
    new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }),
  );
}

/** mousedown goes to the overlay host; move/up are tracked on the window. */
function drag(from: [number, number], to: [number, number]): void {
  const host = overlay();
  if (!host) throw new Error("no overlay mounted");
  mouse("mousedown", from[0], from[1], host);
  mouse("mousemove", to[0], to[1]);
  mouse("mouseup", to[0], to[1]);
}

function lastCaptureRequest(): CaptureRegionRequest {
  const calls = sendMessage.mock.calls;
  if (calls.length === 0) throw new Error("no CAPTURE_REGION request was sent");
  return calls[calls.length - 1][0] as CaptureRegionRequest;
}

describe("rectFromDrag", () => {
  const viewport = { width: 1000, height: 800 };

  it("normalises a right-and-down drag", () => {
    expect(rectFromDrag({ x: 10, y: 20 }, { x: 110, y: 70 }, viewport)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it("normalises a left-and-up drag to the same rectangle", () => {
    expect(rectFromDrag({ x: 110, y: 70 }, { x: 10, y: 20 }, viewport)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it("clamps a drag that left the viewport", () => {
    expect(rectFromDrag({ x: 900, y: 700 }, { x: 1400, y: 1200 }, viewport)).toEqual({
      x: 900,
      y: 700,
      width: 100,
      height: 100,
    });
    expect(rectFromDrag({ x: 100, y: 100 }, { x: -50, y: -80 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });
});

describe("initRegionCapture", () => {
  it("mounts nothing until start() is called", () => {
    initRegionCapture(onCaptured, panel);
    expect(overlay()).toBeNull();
  });

  it("mounts a crosshair overlay in its own shadow root on start()", () => {
    const capture = initRegionCapture(onCaptured, panel);
    capture.start();

    const host = overlay();
    expect(host).not.toBeNull();
    expect(host?.shadowRoot?.querySelector(".backdrop")).not.toBeNull();
    expect(host?.style.cursor).toBe("crosshair");
    expect(capture.isActive()).toBe(true);
  });

  it("does not stack a second overlay when start() is called twice", () => {
    const capture = initRegionCapture(onCaptured, panel);
    capture.start();
    capture.start();

    expect(document.querySelectorAll(`#${HOST_ID}`)).toHaveLength(1);
  });

  it("cancel() removes the overlay", () => {
    const capture = initRegionCapture(onCaptured, panel);
    capture.start();
    capture.cancel();

    expect(overlay()).toBeNull();
    expect(capture.isActive()).toBe(false);
  });

  it("Escape cancels without capturing", () => {
    const capture = initRegionCapture(onCaptured, panel);
    capture.start();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(overlay()).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("tracks the drag as a live rectangle", () => {
    const capture = initRegionCapture(onCaptured, panel);
    capture.start();

    const host = overlay();
    mouse("mousedown", 40, 60, host!);
    mouse("mousemove", 240, 160);

    const rectEl = host?.shadowRoot?.querySelector<HTMLElement>(".rect");
    expect(rectEl?.classList.contains("visible")).toBe(true);
    expect(rectEl?.style.left).toBe("40px");
    expect(rectEl?.style.top).toBe("60px");
    expect(rectEl?.style.width).toBe("200px");
    expect(rectEl?.style.height).toBe("100px");
  });

  it("treats a drag shorter than the minimum edge as a click, not a capture", async () => {
    const capture = initRegionCapture(onCaptured, panel);
    capture.start();
    drag([100, 100], [100 + MIN_CAPTURE_EDGE - 1, 140]);

    expect(overlay()).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(panel.hideForCapture).not.toHaveBeenCalled();
    expect(panel.onError).not.toHaveBeenCalled();
  });

  it("sends the normalised rect and the page's devicePixelRatio", async () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const capture = initRegionCapture(onCaptured, panel);
    capture.start();
    drag([300, 200], [100, 100]);

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(lastCaptureRequest()).toEqual({
      type: "CAPTURE_REGION",
      payload: { rect: { x: 100, y: 100, width: 200, height: 100 }, devicePixelRatio: 2 },
    });
  });

  it("hands the captured image and a region context package to the caller", async () => {
    const capture = initRegionCapture(onCaptured, panel);
    capture.start();
    drag([100, 100], [300, 200]);

    await vi.waitFor(() => expect(onCaptured).toHaveBeenCalled());
    const [captured, context] = onCaptured.mock.calls[0];
    expect(captured).toEqual(image);
    // The picture is the excerpt, so there is no selected text to carry.
    expect(context).toMatchObject({ selectedText: "", screenshot: image });
  });

  /**
   * The bug this feature is most likely to ship with: capture the tab while our
   * own UI is still painted and the panel appears inside its own screenshot.
   */
  it("removes the overlay and hides the panel before asking for the screenshot", async () => {
    const seen: { overlayMounted: boolean; hideCalls: number; askVisibility: string } = {
      overlayMounted: true,
      hideCalls: 0,
      askVisibility: "",
    };
    const askButton = document.createElement("button");
    askButton.id = "sidechats-ask-button";
    document.body.appendChild(askButton);

    sendMessage.mockImplementation(async () => {
      seen.overlayMounted = overlay() !== null;
      seen.hideCalls = panel.hideForCapture.mock.calls.length;
      seen.askVisibility = askButton.style.visibility;
      return { ok: true, kind: "image", image };
    });

    const capture = initRegionCapture(onCaptured, panel);
    capture.start();
    drag([100, 100], [300, 200]);

    await vi.waitFor(() => expect(onCaptured).toHaveBeenCalled());
    expect(seen.overlayMounted).toBe(false);
    expect(seen.hideCalls).toBe(1);
    // The Ask button is light-DOM and outside the panel's shadow host, so
    // hideForCapture() does not cover it — this lane has to.
    expect(seen.askVisibility).toBe("hidden");
  });

  it("puts the panel and the Ask button back afterwards", async () => {
    const askButton = document.createElement("button");
    askButton.id = "sidechats-ask-button";
    askButton.style.visibility = "visible";
    document.body.appendChild(askButton);

    const capture = initRegionCapture(onCaptured, panel);
    capture.start();
    drag([100, 100], [300, 200]);

    await vi.waitFor(() => expect(panel.showAfterCapture).toHaveBeenCalled());
    expect(askButton.style.visibility).toBe("visible");
  });

  it("restores the panel even when the capture fails", async () => {
    sendMessage.mockResolvedValue({
      ok: false,
      error: "Cannot access contents of the page.",
      errorType: "network",
    });

    const capture = initRegionCapture(onCaptured, panel);
    capture.start();
    drag([100, 100], [300, 200]);

    await vi.waitFor(() => expect(panel.onError).toHaveBeenCalled());
    expect(panel.onError).toHaveBeenCalledWith("Cannot access contents of the page.");
    expect(panel.showAfterCapture).toHaveBeenCalled();
    expect(onCaptured).not.toHaveBeenCalled();
  });

  it("reports a reply where an image was expected instead of passing it on", async () => {
    sendMessage.mockResolvedValue({ ok: true, kind: "reply", sideChatId: "a", reply: "hi" });

    const capture = initRegionCapture(onCaptured, panel);
    capture.start();
    drag([100, 100], [300, 200]);

    await vi.waitFor(() => expect(panel.onError).toHaveBeenCalled());
    expect(onCaptured).not.toHaveBeenCalled();
  });

  it("refuses to start once the extension context is gone", () => {
    vi.stubGlobal("chrome", { runtime: {} });

    const capture = initRegionCapture(onCaptured, panel);
    capture.start();

    expect(overlay()).toBeNull();
    expect(panel.onError).toHaveBeenCalledWith(expect.stringMatching(/Reload the page/));
  });

  it("reports the reload remedy when the context dies mid-capture", async () => {
    sendMessage.mockRejectedValue(new Error("Extension context invalidated."));

    const capture = initRegionCapture(onCaptured, panel);
    capture.start();
    drag([100, 100], [300, 200]);

    await vi.waitFor(() => expect(panel.onError).toHaveBeenCalled());
    expect(panel.onError).toHaveBeenCalledWith(expect.stringMatching(/Reload the page/));
    expect(panel.showAfterCapture).toHaveBeenCalled();
  });
});
