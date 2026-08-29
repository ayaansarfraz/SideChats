# SideChats — MVP Build Plan

Note: `AGENTS.md` refers to `PROJECT_CONTEXT.md`, but the actual file in this repo is `PROJECT.md` — that's the one this plan is based on. If a separate `PROJECT_CONTEXT.md` was meant to exist, let me know and I'll reconcile it.

Also note: a backend server already exists at `server/` (Express + Anthropic SDK, in-memory side-chat store, system-prompt builder). It already implements most of "how messages will be sent to the LLM" and "how branch state is stored" on the server side. This plan treats that as **done** and focuses the remaining work on the browser extension, which does not exist yet.

## MVP Scope

Validate one question: *do people actually use contextual side-threads instead of polluting the main chat?*

To test that, we need only:

1. A Chrome extension (Manifest V3) that works on `chatgpt.com`.
2. Detect when the user selects text inside an assistant message.
3. Show a small "Ask" button near the selection.
4. Clicking it opens a lightweight side panel with the selected text pre-filled.
5. User types a question; it's sent (selected text + parent user message + parent AI response) to the local server, which calls Claude and returns a reply.
6. Side panel shows a short back-and-forth thread.
7. Closing the panel leaves the main ChatGPT conversation untouched.

No persistence across reloads, no Claude.ai support, no accounts, no visualization. Just: highlight → ask → get an answer → close.

## Recommended Architecture

```
┌─────────────────────────┐        ┌──────────────────────┐        ┌────────────┐
│ chatgpt.com (page)      │        │ Extension             │        │ Local      │
│                         │ msgs   │ background service    │  HTTP  │ Express    │
│ content script ─────────┼───────▶│ worker (relay + fetch)│───────▶│ server     │
│  - selection detection  │◀───────┤                        │◀───────┤ (existing) │
│  - "Ask" button         │        └──────────────────────┘        └─────┬──────┘
│  - injected side panel  │                                              │
│  (Shadow DOM overlay)   │                                              ▼
└─────────────────────────┘                                     Anthropic API
```

Key decisions baked into this:

- **Injected DOM side panel, not `chrome.sidePanel` API.** Chrome's native side panel API has awkward user-gesture requirements when opened from a content script (the gesture is lost across the async message hop to the background worker). A `position: fixed` panel rendered inside a Shadow DOM root, appended directly to the page, is simpler, faster to build, and gives us full control over animation/styling. This can be swapped for the native API later if desired.
- **Background service worker relays all network calls.** The content script never calls `fetch()` directly against `localhost:3000` — it messages the background worker, which does the fetch. This avoids fighting the host page's CSP and keeps `host_permissions` centralized in the manifest.
- **The extension holds no API keys.** The Anthropic key stays server-side (already the case in `server/`). The extension only ever talks to our own local server.

## Main Components

1. **Content script** (`content/`) — injected into ChatGPT pages. Owns:
   - Selection detection (only within assistant messages)
   - "Ask" button rendering/positioning
   - Side panel mount, lifecycle, and message thread UI
2. **Context extractor** (`content/context.ts`) — given a selection, walks the DOM to find the parent assistant message, the preceding user message, and (optionally) a couple of turns before that.
3. **Background service worker** (`background/`) — relays `createSideChat` / `sendMessage` calls to the local server via `chrome.runtime.onMessage`.
4. **Side panel UI** (`content/panel.ts`) — renders the thread, input box, loading/error states. Vanilla TS + a `<template>`/DOM API, no framework — keeps the bundle trivial.
5. **Server** (`server/`, already built) — `POST /api/side-chats`, `POST /api/side-chats/:id/messages`, `DELETE /api/side-chats/:id`. No changes anticipated except maybe CORS/host tweaks.

## Browser Extension Structure

Manifest V3, unpacked/dev-loaded (not published to the Web Store for the MVP).

```json
{
  "manifest_version": 3,
  "name": "SideChats",
  "version": "0.1.0",
  "permissions": ["storage"],
  "host_permissions": [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
    "http://localhost:3000/*"
  ],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    {
      "matches": ["https://chatgpt.com/*", "https://chat.openai.com/*"],
      "js": ["content.js"],
      "css": ["panel.css"],
      "run_at": "document_idle"
    }
  ]
}
```

Both `chatgpt.com` and the legacy `chat.openai.com` domain are matched since both are in active use/redirect to each other.

## Extracting Selected Text + Surrounding Context

ChatGPT's DOM is a React SPA with obfuscated/rotating class names, so selectors must anchor on **stable attributes**, not class names. ChatGPT currently marks turns with `[data-message-author-role="assistant"|"user"]`. Plan:

1. Listen for `selectionchange` (debounced) or `mouseup` at the document level.
2. When there's a non-empty selection, call `selection.anchorNode` → walk up via `.closest('[data-message-author-role="assistant"]')`.
   - If that returns null, the selection isn't inside an assistant message → do nothing (no "Ask" button).
3. If it matches, that element's `innerText` is the **parent AI response**.
4. Walk to the *previous* sibling turn element with `[data-message-author-role="user"]` → its `innerText` is the **parent user message**.
5. Optionally walk back one more user/assistant pair for **prior context** (kept small — 1 extra turn — per PROJECT.md's "sending the last few relevant messages is acceptable" guidance).
6. Package: `{ selectedText, parentUserMessage, parentAiResponse, priorContext? }` — this matches the server's existing `createSideChat` input shape exactly.

Guardrails:
- Ignore selections that start/end outside any message, or that span multiple messages (MVP: just use the selection's anchor message; don't try to merge context from two messages).
- Use a `MutationObserver` on the main chat container to detect when new messages appear/stream in, so the click handler for "Ask" always targets settled DOM nodes (avoid grabbing a mid-stream partial response — simplest guard is to only show "Ask" after the send button/stop-generating indicator shows the response is done, or just accept partial text for MVP and iterate).

## Side Panel Behavior

- On "Ask" click: mount a Shadow DOM host (`<div id="sidechats-root">` with `attachShadow({mode:'open'})`) appended to `document.body` if not already present.
- Panel slides in from the right, ~380–420px wide, full height, `z-index` maxed out.
- Header shows a trimmed preview of the selected text + a close (×) button.
- Body: empty state with a single input ("Ask about this...") pre-focused.
- On submit: send `{parentUserMessage, parentAiResponse, selectedText, priorContext, question}` to background → server `POST /api/side-chats` → get back `{sideChatId, reply}` → render as a two-bubble thread (user question, AI reply) and keep `sideChatId` in the panel's local state for follow-ups.
- Follow-up questions: `POST /api/side-chats/:id/messages` with just `{question}`.
- Close button: hides the panel (`display: none`) but keeps its DOM/state alive so reopening (e.g. selecting new text) doesn't lose the last thread — reselecting starts a **new** side chat, closing just dismisses the current one. Simplicity: don't support switching between multiple concurrent side chats in v1 — one active panel at a time, opening a new one replaces the old.

## Sending Messages to the LLM

Already implemented server-side and reused as-is:

- `contextPackage.ts` builds a system prompt: role framing + parent user message + parent AI response + selected text + optional prior context.
- `anthropicClient.ts` calls `anthropic.messages.create` with that system prompt plus the accumulating `messages[]` array for the side chat, using `claude-sonnet-5` by default (overridable via `ANTHROPIC_MODEL` env var).
- No streaming in v1 — a single request/response per turn, shown with a loading spinner in the panel. Streaming can be added later without changing the extension's message contract much.

## Branch State Storage

Two layers, matching what already exists:

- **Server (source of truth):** in-memory `Map<sideChatId, SideChat>` in `store.ts`, each holding the full message history, swept after 30 minutes of inactivity. No database for v1 — acceptable since side chats are explicitly ephemeral/exploratory (per PROJECT.md's product philosophy) and nothing here needs to survive a server restart.
- **Extension (session-only):** the currently-open panel keeps `sideChatId` + rendered messages in an in-memory JS variable inside the content script. Nothing is written to `chrome.storage`. A full page reload of the ChatGPT tab loses any open side chat — acceptable for an MVP whose job is just to test the interaction, not to be durable.
- No mapping is kept from "which main-chat message has which branches" (that's the explicitly-deferred "persistent branches / reopen branches" feature).

## Folder / File Structure

```
SideChats/
├── PROJECT.md
├── AGENTS.md
├── BUILD_PLAN.md
├── server/                      # already exists
│   ├── src/
│   │   ├── index.ts
│   │   ├── types.ts
│   │   ├── lib/
│   │   │   ├── anthropicClient.ts
│   │   │   ├── contextPackage.ts
│   │   │   └── store.ts
│   │   └── routes/
│   │       └── sideChats.ts
│   └── package.json
└── extension/                   # new
    ├── manifest.json
    ├── package.json              # esbuild + typescript, dev-only
    ├── tsconfig.json
    ├── src/
    │   ├── background/
    │   │   └── background.ts     # relays requests to localhost:3000
    │   ├── content/
    │   │   ├── content.ts        # entry point: wires selection + button + panel
    │   │   ├── context.ts        # DOM walking / context extraction
    │   │   ├── panel.ts          # side panel render + state
    │   │   └── panel.css
    │   └── shared/
    │       ├── types.ts          # mirrors server/src/types.ts
    │       └── messages.ts       # content↔background message protocol
    └── icons/
        └── icon128.png
```

Build tooling: esbuild bundling `content.ts` → `content.js` and `background.ts` → `background.js` (two entry points, IIFE format for the content script, ESM for the service worker). No React/webpack — keeps the loop fast (`esbuild --watch` + reload unpacked extension).

## Implementation Phases (build order)

0. **(Done)** Server: side-chat CRUD + Anthropic integration — already in `server/`.
1. **Extension skeleton.** `manifest.json`, empty `content.ts` that just `console.log`s on `chatgpt.com`, load unpacked, confirm injection works. Fastest possible sanity check.
2. **Selection detection.** Detect selections inside `[data-message-author-role="assistant"]`, log the extracted `{selectedText, parentUserMessage, parentAiResponse}` to console. Validate against real ChatGPT DOM before building any UI on top — this is the highest-risk part.
3. **"Ask" button.** Floating button appears near the selection on mouseup, positioned via `getBoundingClientRect()` of the selection range. Click just logs the context package for now.
4. **Side panel shell.** Shadow DOM panel, slide-in animation, static UI (no network) — input box, fake/echoed reply — to validate the interaction feels lightweight before wiring the backend.
5. **Wire to backend.** Background worker relay + `fetch` to `localhost:3000`; real question → real Claude reply rendered in the panel.
6. **Follow-up turns.** Reuse `sideChatId` for subsequent questions in the same panel session.
7. **Polish.** Loading/error states, close/reopen behavior, basic styling pass, handle no-selection/edge cases gracefully.
8. **(Stretch, only if time remains)** Claude.ai selector support, behind the same extraction interface.

## Major Technical Risks / Unknowns

- **DOM fragility.** ChatGPT's markup and class names change often; `data-message-author-role` is the most stable anchor available today but isn't guaranteed. Mitigation: isolate all selectors in `context.ts` so a markup change only requires touching one file; fail silently (no "Ask" button) rather than throwing.
- **Streaming responses.** If the user selects text while ChatGPT's own response is still streaming in, `innerText` will be a partial response. MVP may just accept this; a `MutationObserver`-based "is this turn still streaming" check is a fallback if it proves annoying in practice.
- **CSP/CORS from the content script's execution context.** Content scripts nominally bypass page CSP for `fetch`, but behavior has shifted across Chrome versions — routing all network calls through the background service worker sidesteps this risk entirely rather than debugging it live.
- **Style collisions.** ChatGPT's global CSS could leak into the injected panel. Shadow DOM should isolate this, but needs a quick visual check once built.
- **Multi-node selections.** A user selection can span multiple DOM elements (e.g. across a paragraph and a code block) inside one message — `innerText`/`toString()` handling needs a quick check, but since we only need "which message was selected," not perfect boundary text, this is low-severity.
- **Local server dependency.** The extension requires `server/` running locally (`npm run dev`) — fine for a personal prototype, but means testing with anyone else requires either they run the server too, or a first (or a quick, non-production) deploy.

## Integration Contract & Pre-Merge Checklist

*(Added after a cross-worktree review once all 4 parallel tracks in `PARALLEL_PLAN.md` reported "done." This is the authoritative list of what must change before those branches are merged — see `docs/board.md` Messages for the full review.)*

### 1. Fix the `askButton.ts` ↔ `context.ts` interface (blocker) — ✅ done

As written, `initAskButton(onAsk)` has no way to receive Track A's real `getSelectionContext` — it calls a **hardcoded local stub** internally (`"[stub] parent user message"` / `"[stub] parent AI response"`). `PARALLEL_PLAN.md`'s own integration snippet imports `getSelectionContext` from `./context` in `content.ts` but never passes it anywhere, so the import is dead and the stub silently ships to production. This type-checks cleanly and passes every track's own "definition of done" — it only shows up if someone reads the actual reply content, since the fake context still produces a plausible-looking Claude reply.

**Required fix**, in `extension/src/content/askButton.ts` (delete the internal stub function):

```ts
export function initAskButton(
  getContext: (selection: Selection) => ContextPackage | null,
  onAsk: (ctx: ContextPackage) => void,
): void {
  // ...same body, but replace calls to the local stub with getContext(selection)
}
```

And in `content.ts`:

```ts
import { getSelectionContext } from "./context";
import { initAskButton } from "./askButton";
// ...
initAskButton(getSelectionContext, (ctx) => panel.open(ctx));
```

This makes the dependency explicit at the call site instead of relying on someone remembering to hand-edit `askButton.ts` during integration.

### 2. Recover from an expired/missing side chat (high) — ✅ done

The server sweeps idle side chats after 30 minutes (`store.ts`) and returns `404 { error: "Side chat not found" }` for a dead `sideChatId`. In `panel.ts`'s `submit()`, that error is rendered correctly as an error bubble, but `state.sideChatId` is never cleared — every subsequent send keeps retrying the same dead ID and the thread is stuck until the panel is closed and reopened.

**Required fix:** in the error branch of `submit()`, when the result is `{ error }`, reset `state.sideChatId = null` (or specifically match "Side chat not found") so the next send starts a fresh chat via `askSideChat` instead of retrying `continueSideChat` against a dead ID.

### 3. Get a live `ANTHROPIC_API_KEY` (blocker for end-to-end testing)

Confirmed by the `backend-bridge` track directly against the Anthropic SDK: the key currently in `server/.env` returns `401 invalid x-api-key`. Every side-chat request 502s until it's replaced.

### 4. Real chatgpt.com validation, not just fixtures (high)

`context.ts` (Track A) and `askButton.ts` (Track B) were both validated only against static Playwright fixtures (no sandbox browser access), never the live site. `context.ts` in particular is called out elsewhere in this doc as the highest-risk file — ChatGPT's markup/class names churn often, and `data-message-author-role` is an assumption, not a guarantee. Do one real pass on `chatgpt.com` with the fully merged build before calling this mergeable.

### 5. Commit the work (blocker, process)

As of this review, every worktree (`sidechats-extension`, `context-extraction`, `ask-button`, `side-panel`, `backend-bridge`) has all of its implementation sitting as **uncommitted/untracked files** — `git status` shows only the original `Initial commit` on every branch. Nothing here survives a `git worktree remove`, a stray `git clean -fd`, or disk loss. Commit each branch's own files before attempting any merge.

### Lower-priority cleanups (safe to defer past MVP validation)

- ~~**CORS is prefix-matched, not exact**~~ — ✅ done. `server/src/index.ts` now parses `origin` with `new URL()` and checks `protocol === "chrome-extension:"` or exact `hostname === "localhost"`, instead of `startsWith`.
- ~~**Redundant CSS injection**~~ — ✅ done. Dropped the `css` key from `manifest.json`'s content script entry (`side-panel` worktree); `web_accessible_resources` still serves `panel.css` to the Shadow DOM fetch in `panel.ts`.
- **No unit tests** for `context.ts`'s DOM-walking logic — the single most complex, highest-risk piece of logic in the system. The Playwright fixtures already built by Track A/B for manual checks would make cheap jsdom/happy-dom regression tests.
- **No typecheck step wired into the build** — `extension/package.json` only has `dev`/`build` (esbuild strips types without checking them). `npx tsc --noEmit` currently passes clean in every worktree and in a merged integration test, but nothing enforces that going forward; consider adding a `typecheck` script.

## Explicitly NOT Building in v1

- Claude.ai support (ChatGPT only first, per `AGENTS.md`)
- Persistent branches / storage across page reloads or browser restarts
- Reopening past side chats, or any indicator that a message "has branches"
- Promote-to-main / merge-back-into-conversation
- Branch tree visualization
- Embeddings/retrieval-based context selection — plain "last message + selected text" only
- Multiple concurrent open side panels
- User accounts, auth, or multi-user support on the server
- Streaming LLM responses
- Cross-model selection (Anthropic only, matching the existing server)
- Publishing to the Chrome Web Store — unpacked/dev-loaded only
- Any production deployment of `server/` — localhost only
