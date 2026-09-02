import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTENSION_RELOADED_MESSAGE,
  ExtensionContextInvalidatedError,
  isContextInvalidatedError,
  isExtensionAlive,
} from "./runtime";

const globalWithChrome = globalThis as { chrome?: unknown };

afterEach(() => {
  delete globalWithChrome.chrome;
  vi.unstubAllGlobals();
});

describe("isExtensionAlive", () => {
  it("is true while chrome.runtime.id is present", () => {
    globalWithChrome.chrome = { runtime: { id: "abcdefghijklmnop" } };
    expect(isExtensionAlive()).toBe(true);
  });

  it("is false once the id goes away, which is how an invalidated context reads", () => {
    globalWithChrome.chrome = { runtime: {} };
    expect(isExtensionAlive()).toBe(false);
  });

  it("is false when chrome or chrome.runtime is gone entirely", () => {
    globalWithChrome.chrome = {};
    expect(isExtensionAlive()).toBe(false);
    delete globalWithChrome.chrome;
    expect(isExtensionAlive()).toBe(false);
  });

  it("is false rather than throwing when reading chrome.runtime itself throws", () => {
    // Touching the API after invalidation can throw instead of returning
    // undefined, and a throw here would take down the caller's whole flow.
    Object.defineProperty(globalWithChrome, "chrome", {
      configurable: true,
      get() {
        throw new Error("Extension context invalidated.");
      },
    });
    expect(() => isExtensionAlive()).not.toThrow();
    expect(isExtensionAlive()).toBe(false);
  });
});

describe("isContextInvalidatedError", () => {
  it("recognises Chrome's own wording", () => {
    expect(isContextInvalidatedError(new Error("Extension context invalidated."))).toBe(true);
    expect(isContextInvalidatedError(new Error("extension context invalidated"))).toBe(true);
  });

  it("recognises our own error type", () => {
    expect(isContextInvalidatedError(new ExtensionContextInvalidatedError())).toBe(true);
  });

  it("recognises a non-Error rejection carrying the same text", () => {
    expect(isContextInvalidatedError("Extension context invalidated.")).toBe(true);
  });

  it("does not swallow unrelated failures", () => {
    // These must keep reaching the generic error path with their own text —
    // misreporting a dead server as "reload the page" would send the user
    // chasing the wrong problem.
    expect(isContextInvalidatedError(new Error("Failed to fetch"))).toBe(false);
    expect(isContextInvalidatedError(new Error("Side chat not found"))).toBe(false);
    expect(isContextInvalidatedError(null)).toBe(false);
    expect(isContextInvalidatedError(undefined)).toBe(false);
  });
});

describe("EXTENSION_RELOADED_MESSAGE", () => {
  it("tells the user what to do, not just what broke", () => {
    // The whole point of the fix: Chrome's string names neither the cause nor
    // the remedy.
    expect(EXTENSION_RELOADED_MESSAGE.toLowerCase()).toContain("reload the page");
    expect(EXTENSION_RELOADED_MESSAGE).not.toContain("context invalidated");
  });
});
