/**
 * A deliberately small Markdown renderer for assistant replies.
 *
 * The model answers in Markdown, and rendering that as plain text put literal
 * `**bold**`, `- ` bullets and `$$\triangle$$` on screen. This covers the
 * subset that actually shows up in a short clarification — emphasis, code,
 * lists, and light LaTeX — and deliberately stops there: a full Markdown
 * engine is a dependency and an attack surface this panel does not need.
 *
 * Everything is built with DOM APIs and textContent. Model output is never
 * interpolated into innerHTML, so nothing it returns can become markup.
 */

/** LaTeX commands common enough in a study context to be worth unwrapping. */
const LATEX_SYMBOLS: Record<string, string> = {
  triangle: "△",
  cup: "∪",
  cap: "∩",
  setminus: "\\",
  emptyset: "∅",
  in: "∈",
  notin: "∉",
  subseteq: "⊆",
  subset: "⊂",
  supseteq: "⊇",
  neq: "≠",
  leq: "≤",
  geq: "≥",
  times: "×",
  cdot: "·",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  Rightarrow: "⇒",
  iff: "⇔",
  forall: "∀",
  exists: "∃",
  infty: "∞",
  sum: "∑",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  lambda: "λ",
  mu: "μ",
  sigma: "σ",
  theta: "θ",
  pi: "π",
  omega: "ω",
};

/**
 * Unwraps `$…$` / `$$…$$` and swaps known commands for their symbols. Math is
 * not typeset — the goal is readable prose rather than notation, since the
 * panel answers "what does this mean", not "render this equation".
 */
export function normalizeMath(text: string): string {
  const unwrapped = text
    .replace(/\$\$([\s\S]+?)\$\$/g, "$1")
    .replace(/\$([^$\n]+)\$/g, "$1");

  return unwrapped.replace(/\\([a-zA-Z]+)/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(LATEX_SYMBOLS, name) ? LATEX_SYMBOLS[name] : whole,
  );
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;

/** Emphasis, inline code, and nothing else — appended into `parent`. */
function appendInline(parent: Node, text: string): void {
  const doc = parent.ownerDocument ?? document;
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parent.appendChild(doc.createTextNode(text.slice(lastIndex, index)));
    }

    const [, code, boldStar, boldUnderscore, italicStar, italicUnderscore] = match;
    if (code !== undefined) {
      const el = doc.createElement("code");
      el.textContent = code;
      parent.appendChild(el);
    } else if (boldStar !== undefined || boldUnderscore !== undefined) {
      const el = doc.createElement("strong");
      el.textContent = boldStar ?? boldUnderscore ?? "";
      parent.appendChild(el);
    } else {
      const el = doc.createElement("em");
      el.textContent = italicStar ?? italicUnderscore ?? "";
      parent.appendChild(el);
    }
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    parent.appendChild(doc.createTextNode(text.slice(lastIndex)));
  }
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

/**
 * Renders `markdown` into a fragment: paragraphs, bullet and numbered lists,
 * fenced code blocks, and inline emphasis.
 */
export function renderMarkdown(markdown: string, doc: Document = document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const lines = normalizeMath(markdown).split("\n");

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];

    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        body.push(lines[index]);
        index++;
      }
      index++; // closing fence, or the end of the input
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      code.textContent = body.join("\n");
      pre.appendChild(code);
      fragment.appendChild(pre);
      continue;
    }

    if (!line.trim()) {
      index++;
      continue;
    }

    const isBullet = BULLET.test(line);
    const isNumbered = !isBullet && NUMBERED.test(line);
    if (isBullet || isNumbered) {
      const pattern = isBullet ? BULLET : NUMBERED;
      const list = doc.createElement(isBullet ? "ul" : "ol");
      while (index < lines.length && pattern.test(lines[index])) {
        const item = doc.createElement("li");
        appendInline(item, lines[index].match(pattern)![1]);
        list.appendChild(item);
        index++;
      }
      fragment.appendChild(list);
      continue;
    }

    // A paragraph runs until a blank line or the start of another block.
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].trim().startsWith("```") &&
      !BULLET.test(lines[index]) &&
      !NUMBERED.test(lines[index])
    ) {
      paragraph.push(lines[index].trim());
      index++;
    }
    const p = doc.createElement("p");
    appendInline(p, paragraph.join(" "));
    fragment.appendChild(p);
  }

  return fragment;
}
