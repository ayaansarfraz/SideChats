import { describe, expect, it } from "vitest";
import { ADAPTERS, getAdapterForHost } from "./index";
import { hostMatches } from "./types";

describe("hostMatches", () => {
  it("matches the host itself and its subdomains", () => {
    expect(hostMatches("claude.ai", "claude.ai")).toBe(true);
    expect(hostMatches("www.claude.ai", "claude.ai")).toBe(true);
    expect(hostMatches("CLAUDE.AI", "claude.ai")).toBe(true);
  });

  it("does not match lookalike hosts", () => {
    // The suffix check has to be on a dot boundary, or a host someone else
    // controls would be treated as claude.ai.
    expect(hostMatches("notclaude.ai", "claude.ai")).toBe(false);
    expect(hostMatches("claude.ai.example.com", "claude.ai")).toBe(false);
    expect(hostMatches("claude.aisomething.com", "claude.ai")).toBe(false);
  });
});

describe("getAdapterForHost", () => {
  it("routes each supported host to its adapter", () => {
    expect(getAdapterForHost("chatgpt.com")?.id).toBe("chatgpt");
    expect(getAdapterForHost("chat.openai.com")?.id).toBe("chatgpt");
    expect(getAdapterForHost("claude.ai")?.id).toBe("claude");
    expect(getAdapterForHost("www.claude.ai")?.id).toBe("claude");
  });

  it("returns null for an unsupported host", () => {
    expect(getAdapterForHost("example.com")).toBeNull();
    expect(getAdapterForHost("gemini.google.com")).toBeNull();
  });
});

describe("adapter definitions", () => {
  it("declares a usable turn selector and accent for every adapter", () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.turnSelector.length).toBeGreaterThan(0);
      expect(adapter.hosts.length).toBeGreaterThan(0);
      expect(adapter.accentColor).toMatch(/^#[0-9a-f]{6}$/i);
      // A malformed selector would throw here rather than silently matching
      // nothing at runtime on the live site.
      expect(() => document.querySelectorAll(adapter.turnSelector)).not.toThrow();
    }
  });

  it("gives each site its own accent so the Ask button is not always ChatGPT green", () => {
    const accents = new Set(ADAPTERS.map((a) => a.accentColor));
    expect(accents.size).toBe(ADAPTERS.length);
  });
});
