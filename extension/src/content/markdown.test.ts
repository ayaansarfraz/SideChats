import { describe, expect, it } from "vitest";
import { normalizeMath, renderMarkdown } from "./markdown";

function html(markdown: string): string {
  const host = document.createElement("div");
  host.appendChild(renderMarkdown(markdown, document));
  return host.innerHTML;
}

function text(markdown: string): string {
  const host = document.createElement("div");
  host.appendChild(renderMarkdown(markdown, document));
  return host.textContent ?? "";
}

describe("normalizeMath", () => {
  it("unwraps display and inline delimiters", () => {
    expect(normalizeMath("$$a + b$$")).toBe("a + b");
    expect(normalizeMath("the set $S$ is small")).toBe("the set S is small");
  });

  it("swaps known commands for symbols", () => {
    expect(normalizeMath("$M \\triangle N$")).toBe("M △ N");
    expect(normalizeMath("$e \\in M$ but $e \\notin N$")).toBe("e ∈ M but e ∉ N");
  });

  it("leaves unknown commands alone rather than mangling them", () => {
    expect(normalizeMath("\\begin{proof}")).toBe("\\begin{proof}");
  });

  it("leaves a lone dollar sign alone", () => {
    expect(normalizeMath("it costs $5 to run")).toBe("it costs $5 to run");
  });
});

describe("renderMarkdown", () => {
  it("renders emphasis and inline code as elements, not literal characters", () => {
    const out = html("plain **bold** and *italic* and `code`");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain("<code>code</code>");
    expect(text("plain **bold**")).not.toContain("*");
  });

  it("renders bullet lists", () => {
    const out = html("- first\n- second");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>first</li>");
    expect(out).toContain("<li>second</li>");
  });

  it("renders numbered lists as an ordered list", () => {
    const out = html("1. first\n2. second");
    expect(out).toContain("<ol>");
    expect(out).toContain("<li>second</li>");
  });

  it("renders fenced code blocks verbatim", () => {
    const out = html("```\nconst a = **not bold**;\n```");
    expect(out).toContain("<pre><code>const a = **not bold**;</code></pre>");
  });

  it("joins wrapped lines into one paragraph and splits on blank lines", () => {
    const host = document.createElement("div");
    host.appendChild(renderMarkdown("one\ntwo\n\nthree", document));
    const paragraphs = host.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].textContent).toBe("one two");
    expect(paragraphs[1].textContent).toBe("three");
  });

  it("never turns model output into markup", () => {
    // The whole point of building this with DOM APIs: a reply containing HTML
    // has to arrive as visible text, not as elements.
    const out = html('<img src=x onerror="alert(1)"> and <b>bold</b>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(text('<img src=x onerror="alert(1)">')).toContain("<img");
  });

  it("handles the real shape of an answer end to end", () => {
    const out = html(
      "Here is $M \\triangle N$:\n\n- $e \\in M$ but **not** in N\n- the other way round\n\nSo `M = N`.",
    );
    expect(out).toContain("△");
    expect(out).toContain("∈");
    expect(out).toContain("<ul>");
    expect(out).toContain("<strong>not</strong>");
    expect(out).toContain("<code>M = N</code>");
    expect(out).not.toContain("$");
  });
});
