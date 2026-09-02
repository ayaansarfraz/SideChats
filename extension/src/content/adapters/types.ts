import type { Role } from "../../shared/types";

/**
 * Per-site knowledge about how a chat page marks up its conversation.
 *
 * Everything site-specific lives behind this interface so `context.ts` can stay
 * a single generic turn-walker: adding a third host means writing one adapter,
 * not another branch inside the extraction logic.
 */
export type SiteAdapter = {
  /** Stable id, used in logs and tests. */
  id: "chatgpt" | "claude";

  /** Human-readable name, used in logs. */
  label: string;

  /**
   * Hostnames this adapter drives. A hostname matches if it equals one of these
   * or is a subdomain of it, so `www.claude.ai` matches `claude.ai`.
   */
  hosts: string[];

  /**
   * Selector matching every conversation turn — user *and* assistant.
   *
   * It may match nested elements; `collectTurns` keeps only the outermost
   * element of each nested group, so a site can list several fallback selectors
   * for the same turn without that turn being counted twice.
   */
  turnSelector: string;

  /**
   * Classify an element matched by `turnSelector`. Returning `null` means "this
   * matched but is not a turn we understand", and the element is ignored.
   */
  roleOf(el: Element): Role | null;

  /**
   * In-turn UI chrome that should not end up in the extracted text — code-block
   * "Copy" buttons, action bars, and the like. Optional; when omitted the
   * turn's text is read as-is.
   */
  noiseSelectors?: string[];

  /** Accent colour for the "Ask" button, so it looks native on each site. */
  accentColor: string;
};

/** True if `hostname` is `host` or a subdomain of it. */
export function hostMatches(hostname: string, host: string): boolean {
  const h = hostname.toLowerCase();
  const target = host.toLowerCase();
  return h === target || h.endsWith(`.${target}`);
}
