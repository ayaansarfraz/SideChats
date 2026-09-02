/**
 * Markup fixtures mirroring how claude.ai renders a conversation.
 *
 * These reproduce the structural traits the adapter actually depends on — the
 * `data-testid="user-message"` hook, the `font-claude-*` response container,
 * the `data-is-streaming` wrapper around it, the per-turn render-count
 * wrapper, and the layout divs in between — rather than being a minimal
 * two-div stand-in. The nesting is the point: it is what proves the adapter
 * counts a turn once when several of its selectors match the same turn.
 *
 * They are still fixtures, not the live site.
 */

export type FixtureTurn = { role: "user" | "assistant"; html: string };

/** Markup for one turn in claude.ai's current shape. */
function currentTurn(turn: FixtureTurn, index: number): string {
  if (turn.role === "user") {
    return `
      <div data-test-render-count="${index}">
        <div class="group relative">
          <div class="flex flex-col gap-2">
            <div data-testid="user-message" class="font-user-message">
              ${turn.html}
            </div>
          </div>
          <div class="absolute right-0">
            <button type="button" aria-label="Edit message">Edit</button>
          </div>
        </div>
      </div>`;
  }
  return `
    <div data-test-render-count="${index}">
      <div class="group relative">
        <div data-is-streaming="false">
          <div class="font-claude-response">
            <div class="grid-cols-1 grid gap-2.5">
              ${turn.html}
            </div>
          </div>
        </div>
        <div data-testid="action-bar">
          <button type="button" aria-label="Copy">Copy</button>
          <button type="button" aria-label="Retry">Retry</button>
        </div>
      </div>
    </div>`;
}

/**
 * Markup for one turn in an older claude.ai shape: the response carries
 * `font-claude-message` and there is no `data-is-streaming` wrapper. Used to
 * prove the adapter's selector list really is a fallback chain and not just a
 * list where the first entry happens to match.
 */
function legacyTurn(turn: FixtureTurn, index: number): string {
  if (turn.role === "user") {
    return `
      <div data-test-render-count="${index}">
        <div data-testid="user-message">${turn.html}</div>
      </div>`;
  }
  return `
    <div data-test-render-count="${index}">
      <div class="font-claude-message">${turn.html}</div>
    </div>`;
}

function page(turnsHtml: string): string {
  return `
    <nav aria-label="Sidebar">
      <a href="/new">New chat</a>
      <p id="sidebar-note">Recent chats live out here, outside the conversation.</p>
    </nav>
    <main>
      <div class="flex flex-col gap-6">
        ${turnsHtml}
      </div>
    </main>`;
}

/** A claude.ai conversation in the current markup. */
export function claudeConversation(turns: FixtureTurn[]): string {
  return page(turns.map(currentTurn).join("\n"));
}

/** The same conversation in the older `font-claude-message` markup. */
export function legacyClaudeConversation(turns: FixtureTurn[]): string {
  return page(turns.map(legacyTurn).join("\n"));
}
