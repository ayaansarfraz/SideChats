import { describe, expect, it, vi } from "vitest";
import { URL_POLL_MS, onUrlChange } from "./navigation";

/**
 * The watcher is built out of two halves — a real `popstate` event and a poll —
 * because a content script runs in an isolated world and cannot see the host
 * app's own `history.pushState` calls. Both halves are covered here with the
 * clock and the URL injected, so neither needs a browser.
 */
function harness(startHref: string) {
  let href = startHref;
  let tick: (() => void) | null = null;
  let popstate: (() => void) | null = null;
  const changes: string[] = [];
  const cleared: number[] = [];

  const watcher = onUrlChange((url) => changes.push(url), {
    getHref: () => href,
    setInterval: (handler) => {
      tick = handler;
      return 7;
    },
    clearInterval: (id) => {
      cleared.push(id);
      tick = null;
    },
    addEventListener: (_type, handler) => {
      popstate = handler;
    },
    removeEventListener: () => {
      popstate = null;
    },
  });

  return {
    watcher,
    changes,
    cleared,
    goTo(next: string) {
      href = next;
    },
    poll: () => tick?.(),
    back: () => popstate?.(),
  };
}

describe("onUrlChange", () => {
  it("reports an in-app navigation the poll picks up", () => {
    const h = harness("https://chatgpt.com/c/a");

    h.goTo("https://chatgpt.com/c/b");
    h.poll();

    expect(h.changes).toEqual(["https://chatgpt.com/c/b"]);
  });

  it("reports back/forward without waiting for the poll", () => {
    const h = harness("https://chatgpt.com/c/a");

    h.goTo("https://chatgpt.com/c/a-previous");
    h.back();

    expect(h.changes).toEqual(["https://chatgpt.com/c/a-previous"]);
  });

  it("says nothing when the URL has not moved", () => {
    const h = harness("https://chatgpt.com/c/a");

    h.poll();
    h.back();
    h.poll();

    expect(h.changes).toEqual([]);
  });

  it("reports each navigation once, however it is noticed", () => {
    const h = harness("https://chatgpt.com/c/a");

    h.goTo("https://chatgpt.com/c/b");
    h.back();
    h.poll();

    expect(h.changes).toEqual(["https://chatgpt.com/c/b"]);
  });

  it("stops listening and stops polling when torn down", () => {
    const h = harness("https://chatgpt.com/c/a");

    h.watcher.stop();
    h.goTo("https://chatgpt.com/c/b");
    h.poll();
    h.back();

    expect(h.changes).toEqual([]);
    expect(h.cleared).toEqual([7]);
  });

  it("defaults to the real window when nothing is injected", () => {
    const setInterval = vi.spyOn(window, "setInterval").mockReturnValue(1 as never);
    const addEventListener = vi.spyOn(window, "addEventListener");

    const watcher = onUrlChange(() => {});

    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), URL_POLL_MS);
    expect(addEventListener).toHaveBeenCalledWith("popstate", expect.any(Function));

    watcher.stop();
    setInterval.mockRestore();
    addEventListener.mockRestore();
  });
});
