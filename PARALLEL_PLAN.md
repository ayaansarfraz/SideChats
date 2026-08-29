# SideChats — Parallel Build Plan (Phase 1 / MVP)

Goal: finish the working prototype described in `BUILD_PLAN.md` by splitting the remaining work into **4 independent tracks**, each owned by its own Claude Code session in its own git worktree, all building against a shared TypeScript contract so they can be merged with minimal conflict.

Already done (do not redo):
- `server/` — Express + Anthropic backend, fully working (`POST /api/side-chats`, `POST /api/side-chats/:id/messages`, `DELETE /api/side-chats/:id`).
- `extension/manifest.json`, `extension/build.mjs` — MV3 skeleton + esbuild bundling, verified working (loads unpacked, content script + background worker both log on start).
- `extension/src/shared/types.ts` and `extension/src/shared/messages.ts` — the contract every track below builds against. **Nobody should edit these two files without flagging it to the others first** — a change here breaks everyone.

## Why these 4 tracks (and not more/fewer)

Each track owns a distinct file (or small file group), and none of them needs another track's *implementation* to start — only the *type signature*, which is fixed below. That means all four can start at the same time from a clean worktree, using a stub for whatever they depend on, and be merged afterward.

```
Track A: context.ts  ──▶ (signature only) ──▶ Track B: askButton.ts
Track D: apiClient.ts + background.ts ──▶ (signature only) ──▶ Track C: panel.ts
                              │
                              ▼
                    Integration (not parallel — see bottom)
                       content.ts glue, ~20 lines
```

Every track shares only `extension/src/shared/types.ts` (read-only) and, for Track D, `extension/src/shared/messages.ts` (owned by Track D, but its shape is already fixed below — don't change it without telling the other tracks).

## Shared contract (already written, all tracks import this)

`extension/src/shared/types.ts`:
```ts
export type Role = "user" | "assistant";
export type ChatMessage = { role: Role; content: string };

export type ContextPackage = {
  selectedText: string;
  parentUserMessage: string;
  parentAiResponse: string;
  priorContext?: string;
};

export type SideChatStatus = "idle" | "loading" | "error";
export type SideChatState = {
  sideChatId: string | null;
  contextPackage: ContextPackage;
  messages: ChatMessage[];
  status: SideChatStatus;
  error?: string;
};
```

`extension/src/shared/messages.ts` (content↔background protocol, owned by Track D):
```ts
export type CreateSideChatRequest = { type: "CREATE_SIDE_CHAT"; payload: ContextPackage & { question: string } };
export type SendMessageRequest = { type: "SEND_MESSAGE"; payload: { sideChatId: string; question: string } };
export type ExtensionRequest = CreateSideChatRequest | SendMessageRequest;
export type ExtensionResponse = { ok: true; sideChatId: string; reply: string } | { ok: false; error: string };
```

---

## Track A — Context Extraction

**Worktree/branch:** `feature/context-extraction`
**Owns:** `extension/src/content/context.ts` (new file)
**Touches nothing else.** Reads `shared/types.ts` only.

**Exported interface (must match exactly):**
```ts
export function getSelectionContext(selection: Selection): ContextPackage | null;
```

**What it does:** Given the browser's current `Selection`, determine whether it's inside a ChatGPT assistant message. If not, return `null`. If it is, walk the DOM to build a `ContextPackage`:
- `selectedText` = `selection.toString()`
- `parentAiResponse` = `innerText` of the nearest ancestor `[data-message-author-role="assistant"]`
- `parentUserMessage` = `innerText` of the nearest *preceding* `[data-message-author-role="user"]` turn
- `priorContext` (optional) = `innerText` of one more user/assistant turn pair before that, if present, joined into a short block

This is the highest-risk part of the whole project (ChatGPT's DOM structure/class names churn constantly), so validate against the **real, live** chatgpt.com DOM, not assumptions.

**Definition of done:**
- `getSelectionContext` correctly returns `null` when the selection is outside any assistant message, or is inside a user message.
- Correctly extracts all fields when a real selection is made inside a real ChatGPT response, tested by hand on chatgpt.com.
- Handles a selection that spans multiple DOM nodes inside one message (e.g. crosses a paragraph and a code block) without throwing.
- No dependency on any other track's files.

---

## Track B — Ask Button / Selection Trigger

**Worktree/branch:** `feature/ask-button`
**Owns:** `extension/src/content/askButton.ts` (new file)
**Depends on Track A's signature only** (not its implementation — write a local stub with the identical signature and swap it at integration time).

**Exported interface:**
```ts
export function initAskButton(onAsk: (ctx: ContextPackage) => void): void;
```

**What it does:**
- Listens for `mouseup` (or debounced `selectionchange`) on `document`.
- On a non-empty selection, calls `getSelectionContext(window.getSelection())` — **use a local stub function with this exact signature** (e.g. return a hardcoded fake `ContextPackage` when selection is non-empty) so you don't need Track A's file to exist.
- If the result isn't `null`, render a small floating "Ask" button positioned near the end of the selection (`range.getBoundingClientRect()`).
- Button disappears on scroll, on a new selection, or on click-away.
- On click, calls `onAsk(ctx)` with the extracted context and removes the button.

**Definition of done:**
- Button appears reliably near a text selection and disappears appropriately (scroll / click elsewhere / new selection).
- Clicking it invokes the `onAsk` callback exactly once with the stubbed context.
- Positioning works near viewport edges (doesn't render off-screen).
- No dependency on any other track's files (stub only).

---

## Track C — Side Panel UI

**Worktree/branch:** `feature/side-panel`
**Owns:** `extension/src/content/panel.ts`, `extension/src/content/panel.css`
**Depends on nothing but a mock.**

**Exported interface:**
```ts
export type PanelDeps = {
  onSubmit: (question: string, state: SideChatState) => Promise<{ reply: string; sideChatId?: string } | { error: string }>;
};

export type PanelController = {
  open: (ctx: ContextPackage) => void;
  close: () => void;
};

export function createPanel(deps: PanelDeps): PanelController;
```

**What it does:**
- Mounts a single Shadow DOM host (`<div id="sidechats-root">` appended to `document.body`, `attachShadow({mode:'open'})`) the first time `open()` is called; reuses it after.
- Panel: fixed position, right-docked, ~380–420px wide, full height, high `z-index`, slide-in transition.
- Header: trimmed preview of `ctx.selectedText` + close (×) button.
- Body: empty state with a focused text input ("Ask about this...").
- On submit: render the user's question as a bubble, show a loading indicator, call `deps.onSubmit(question, currentState)`, then render the reply bubble (or an inline error state if `{error}` comes back). Track the running `SideChatState` (messages, `sideChatId`, `status`) internally so subsequent submits are follow-ups, not new chats.
- `close()` hides the panel (don't destroy its DOM/state — closing and reselecting starts fresh via a new `open()` call, which should reset state for the new context).

**For development, use a mock `onSubmit`:** delay ~500ms via `setTimeout`, then resolve with `{ reply: "Echo: " + question, sideChatId: "mock-id" }`. This lets you build and test the whole UI without the backend existing.

**Definition of done:**
- Panel opens/closes smoothly, doesn't visually collide with chatgpt.com's own styles (Shadow DOM should guarantee this — verify on the real site).
- Multi-turn thread renders correctly (question/answer bubbles stack, scroll works).
- Loading and error states are visually distinct and don't get stuck.
- Verified against the mock `onSubmit`; no dependency on Track D's real implementation.

---

## Track D — Backend Bridge (background worker + API client)

**Worktree/branch:** `feature/backend-bridge`
**Owns:** `extension/src/background/background.ts`, `extension/src/content/apiClient.ts` (new file), `extension/src/shared/messages.ts` (already drafted above — extend only if truly necessary, and note the change clearly in your final report)
**Depends on:** the real `server/` (already built) running locally via `cd server && npm run dev`. No stubbing needed — this track talks to the real thing.

**Exported interface (from `apiClient.ts`, called by content-script code):**
```ts
export async function askSideChat(ctx: ContextPackage, question: string): Promise<{ sideChatId: string; reply: string }>;
export async function continueSideChat(sideChatId: string, question: string): Promise<{ reply: string }>;
```

**What it does:**
- `background.ts`: a `chrome.runtime.onMessage` listener that receives `ExtensionRequest` messages (from `shared/messages.ts`), performs the actual `fetch` against `http://localhost:3000/api/side-chats` (POST, for `CREATE_SIDE_CHAT`) or `http://localhost:3000/api/side-chats/:id/messages` (POST, for `SEND_MESSAGE`), and responds with an `ExtensionResponse`. Handle non-2xx responses and network failures by resolving `{ ok: false, error }` rather than throwing across the message boundary.
- `apiClient.ts`: thin wrapper around `chrome.runtime.sendMessage`, exposing the two async functions above. This is what Tracks B/C's integration point will actually call once merged (but neither of them needs to know that during their own development — they use stubs/mocks).

**Definition of done:**
- With `server/` running locally, a manual test (temporarily call `askSideChat`/`continueSideChat` from a throwaway line in `content.ts`, log the result, then revert that line before finishing) proves a full round trip: extension → background → local server → Anthropic → back to the extension.
- Network/server errors surface as `{ ok: false, error }`, not silent failures or thrown exceptions inside the service worker.
- Confirm CORS actually works from a real `chrome-extension://` origin (not just `http://localhost`) — the server's CORS config already allows this, but verify it in practice, not just by reading the code.
- If anything about the server's request/response shape doesn't match what's assumed here, you own fixing it — either adjust `apiClient.ts` to match reality, or (only if clearly a server bug) make a minimal fix in `server/`.

---

## Integration (not a parallel track)

Once all four branches are ready, one person (you, or whichever session finishes last) merges them and writes the ~20-line glue file `extension/src/content/content.ts`:

```ts
import { getSelectionContext } from "./context";
import { initAskButton } from "./askButton";
import { createPanel } from "./panel";
import { askSideChat, continueSideChat } from "./apiClient";

const panel = createPanel({
  onSubmit: async (question, state) => {
    if (!state.sideChatId) {
      const { sideChatId, reply } = await askSideChat(state.contextPackage, question);
      return { reply, sideChatId };
    }
    const { reply } = await continueSideChat(state.sideChatId, question);
    return { reply };
  },
});

initAskButton((ctx) => panel.open(ctx));
```

Then: swap Track B's stub `getSelectionContext` for the real import from Track A, run `npm run build`, load unpacked, and do one end-to-end pass on chatgpt.com: select text → Ask → ask a question → get a real Claude reply → ask a follow-up → close panel. This is also when Track #3 (Ask button) and #7 (Polish) from the original `BUILD_PLAN.md` phase list get their final pass.

---

## Setting up each worktree

From the main repo root (`/Users/ayaansarfraz/Documents/SideChats`), for each track:

```bash
git worktree add .claude/worktrees/<track-name> -b feature/<track-name>
```

Then copy in the shared foundation (everything below is currently untracked in git, so a fresh worktree won't have it otherwise):

```bash
SRC=/Users/ayaansarfraz/Documents/SideChats/.claude/worktrees/sidechats-extension
DST=/Users/ayaansarfraz/Documents/SideChats/.claude/worktrees/<track-name>
cp "$SRC/PROJECT.md" "$SRC/AGENTS.md" "$SRC/BUILD_PLAN.md" "$SRC/PARALLEL_PLAN.md" "$DST/"
cp "$SRC/.gitignore" "$DST/.gitignore"
rsync -a --exclude node_modules "$SRC/server/" "$DST/server/"
rsync -a --exclude node_modules --exclude dist "$SRC/extension/" "$DST/extension/"
```

(`<track-name>` = `context-extraction`, `ask-button`, `side-panel`, or `backend-bridge`.) Then in each worktree's `extension/` folder, run `npm install`.

Then start a Claude Code session in that worktree's directory and paste the corresponding prompt below.

---

## Prompts to paste into each session

### Track A prompt

```
Read PROJECT.md and BUILD_PLAN.md in this repo for full product context, then read PARALLEL_PLAN.md's "Track A — Context Extraction" section closely — that section is your exact spec, file ownership, and definition of done. Do not read the other track sections as instructions for you; they're for other sessions working in parallel worktrees.

You're building extension/src/content/context.ts in the SideChats browser extension. Implement getSelectionContext(selection: Selection): ContextPackage | null exactly as specified in PARALLEL_PLAN.md, importing ContextPackage from ../shared/types.

You do not need to touch any other file. Do not modify extension/src/shared/types.ts or extension/src/shared/messages.ts.

To validate: load the extension unpacked from extension/dist/ (run `npm run build` inside extension/ first) on real chatgpt.com pages, temporarily wire a one-line call from content.ts to log the result of getSelectionContext on selection, and confirm it correctly detects/ignores selections and extracts the right text. Revert your temporary content.ts wiring before you're done (content.ts belongs to the integration step, not you) — but keep context.ts itself.

When the definition of done in PARALLEL_PLAN.md is met, tell me what you tested it against and any DOM-selector assumptions you had to make (e.g. if data-message-author-role turned out not to be reliable, what you used instead).
```

### Track B prompt

```
Read PROJECT.md and BUILD_PLAN.md in this repo for full product context, then read PARALLEL_PLAN.md's "Track B — Ask Button / Selection Trigger" section closely — that section is your exact spec, file ownership, and definition of done. Do not read the other track sections as instructions for you; they're for other sessions working in parallel worktrees.

You're building extension/src/content/askButton.ts in the SideChats browser extension. Implement initAskButton(onAsk: (ctx: ContextPackage) => void): void exactly as specified in PARALLEL_PLAN.md.

Another parallel session owns extension/src/content/context.ts (a function getSelectionContext(selection: Selection): ContextPackage | null). Don't wait for it or read it — write your own local stub with that exact signature inside askButton.ts (or a local scratch file) that returns a hardcoded fake ContextPackage for any non-empty selection. This will be swapped for the real implementation at integration time, after your branch is merged — you don't need to do that swap yourself.

You do not need to touch any other file. Do not modify extension/src/shared/types.ts.

To validate: load the extension unpacked from extension/dist/ (run `npm run build` inside extension/ first) on real chatgpt.com pages, confirm the Ask button appears near a selection, disappears on scroll/click-away/new selection, and that clicking it fires your onAsk callback with the stubbed context (verify via console.log from a temporary content.ts wiring — revert that wiring before you're done, but keep askButton.ts).

When the definition of done in PARALLEL_PLAN.md is met, tell me about any edge cases you hit with button positioning near viewport edges.
```

### Track C prompt

```
Read PROJECT.md and BUILD_PLAN.md in this repo for full product context, then read PARALLEL_PLAN.md's "Track C — Side Panel UI" section closely — that section is your exact spec, file ownership, and definition of done. Do not read the other track sections as instructions for you; they're for other sessions working in parallel worktrees.

You're building extension/src/content/panel.ts and extension/src/content/panel.css in the SideChats browser extension. Implement createPanel(deps: PanelDeps): PanelController exactly as specified in PARALLEL_PLAN.md, importing ContextPackage/SideChatState from ../shared/types.

Build and test entirely against a mock onSubmit (delay ~500ms, then resolve with a fake echoed reply) as described in the spec — do not wait on or depend on any other track's files. The panel must be mounted in a Shadow DOM root so chatgpt.com's own CSS can't leak in or be leaked into.

You do not need to touch any other file. Do not modify extension/src/shared/types.ts.

To validate: load the extension unpacked from extension/dist/ (run `npm run build` inside extension/ first), wire a temporary call from content.ts that calls createPanel with your mock onSubmit and opens it on some trigger (e.g. a keyboard shortcut or a temporary always-visible test button) so you can interact with it directly on chatgpt.com. Confirm open/close, multi-turn rendering, loading state, and error state all work, and that it looks correct visually against the real site. Revert your temporary content.ts wiring before you're done, but keep panel.ts/panel.css.

When the definition of done in PARALLEL_PLAN.md is met, send me a description (or ASCII sketch) of the final panel layout and any visual decisions you made that weren't specified (colors, spacing, animation timing).
```

### Track D prompt

```
Read PROJECT.md and BUILD_PLAN.md in this repo for full product context, then read PARALLEL_PLAN.md's "Track D — Backend Bridge" section closely — that section is your exact spec, file ownership, and definition of done. Do not read the other track sections as instructions for you; they're for other sessions working in parallel worktrees.

You're building extension/src/background/background.ts and extension/src/content/apiClient.ts in the SideChats browser extension, using the message protocol already drafted in extension/src/shared/messages.ts. Implement askSideChat and continueSideChat exactly as specified in PARALLEL_PLAN.md.

Unlike the other parallel tracks, you don't need a stub — server/ is a fully working Express + Anthropic backend already. Start it with `cd server && npm run dev` (you'll need an ANTHROPIC_API_KEY in server/.env — check server/.env.example; ask me for a key if one isn't already configured) and build/test against the real thing.

You do not need to touch any other file, except extension/src/shared/messages.ts if you find the drafted protocol genuinely doesn't work — if you change it, say so clearly in your final report since two other sessions may end up importing from it.

To validate: with the server running, temporarily call askSideChat and continueSideChat from content.ts with a hardcoded fake ContextPackage and question, confirm you get a real Claude reply through the full extension → background → server → Anthropic → back round trip, and confirm errors (stop the server and try again) surface as { ok: false, error } rather than crashing the service worker. Also verify CORS actually works from a real chrome-extension:// origin, not just localhost. Revert your temporary content.ts wiring before you're done, but keep background.ts and apiClient.ts.

When the definition of done in PARALLEL_PLAN.md is met, tell me if you had to touch server/ at all, and why.
```
