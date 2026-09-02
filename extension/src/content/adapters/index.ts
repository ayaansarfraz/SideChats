import { chatgptAdapter } from "./chatgpt";
import { claudeAdapter } from "./claude";
import { hostMatches, type SiteAdapter } from "./types";

export type { SiteAdapter } from "./types";
export { chatgptAdapter } from "./chatgpt";
export { claudeAdapter } from "./claude";

export const ADAPTERS: SiteAdapter[] = [chatgptAdapter, claudeAdapter];

/**
 * Pick the adapter for a hostname, or `null` if the extension has no support
 * for that site. In practice `manifest.json` only injects the content script on
 * hosts an adapter covers, so `null` means the two lists have drifted apart.
 */
export function getAdapterForHost(hostname: string): SiteAdapter | null {
  return ADAPTERS.find((a) => a.hosts.some((h) => hostMatches(hostname, h))) ?? null;
}
