/**
 * Helpers for driving a real `Selection` over a fixture document, so tests
 * exercise the same Selection/Range path the content script sees rather than
 * hand-built stand-in objects.
 */

/** The first text node under `root` whose content includes `needle`. */
function findTextNode(root: ParentNode, needle: string): { node: Text; offset: number } {
  const doc = (root as Node).ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root as Node, /* NodeFilter.SHOW_TEXT */ 4);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const offset = node.data.indexOf(needle);
    if (offset !== -1) return { node, offset };
    node = walker.nextNode() as Text | null;
  }
  throw new Error(`fixture has no text node containing ${JSON.stringify(needle)}`);
}

/** Select exactly `needle` where it first appears under `root`. */
export function selectText(root: ParentNode, needle: string): Selection {
  const doc = ((root as Node).ownerDocument ?? root) as Document;
  const { node, offset } = findTextNode(root, needle);
  const selection = doc.defaultView!.getSelection()!;
  selection.removeAllRanges();
  const range = doc.createRange();
  range.setStart(node, offset);
  range.setEnd(node, offset + needle.length);
  selection.addRange(range);
  return selection;
}

/**
 * Select from the start of `from` to the end of `to` as a left-to-right drag:
 * `anchorNode` is in `from`, `focusNode` is in `to`.
 */
export function selectAcross(root: ParentNode, from: string, to: string): Selection {
  const doc = ((root as Node).ownerDocument ?? root) as Document;
  const start = findTextNode(root, from);
  const end = findTextNode(root, to);
  const selection = doc.defaultView!.getSelection()!;
  selection.removeAllRanges();
  const range = doc.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + to.length);
  selection.addRange(range);
  return selection;
}

/**
 * The same span dragged right-to-left, so `anchorNode` is in `to` and
 * `focusNode` is in `from`. Which end the anchor is on decides which turn a
 * selection is attributed to, so tests need to be able to build both.
 */
export function selectAcrossBackwards(root: ParentNode, from: string, to: string): Selection {
  const doc = ((root as Node).ownerDocument ?? root) as Document;
  const start = findTextNode(root, from);
  const end = findTextNode(root, to);
  const selection = doc.defaultView!.getSelection()!;
  selection.removeAllRanges();
  selection.setBaseAndExtent(end.node, end.offset + to.length, start.node, start.offset);
  return selection;
}

/** An empty (collapsed) selection. */
export function selectNothing(doc: Document): Selection {
  const selection = doc.defaultView!.getSelection()!;
  selection.removeAllRanges();
  return selection;
}
