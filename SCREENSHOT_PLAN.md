# Screenshots in side chats — parallel build

## Context

SideChats today branches off **text only**: you highlight words in an assistant turn, `context.ts` walks the DOM for the surrounding turn, and the panel sends a string question to a local Express server that forwards a string-content message to the Anthropic API. Every layer of the pipe — `ChatMessage.content`, `Message.content`, `askSideChat`'s `messages[]` — is typed `string`.

But a lot of what people want to ask about on ChatGPT/Claude isn't text: a rendered chart, a diagram, a table that lost its structure, a screenshot someone pasted in. Right now those are unaskable, and the workaround (describe the picture in words) is exactly the friction SideChats exists to remove.

**Goal:** an image can (a) *seed* a side chat — drag a region of the page and ask about it, no text selection needed — and (b) ride along with any follow-up message, via drag-region, clipboard paste, or file attach. Images go to the server once and are stored with the side chat, matching how the rest of the state already works.

Branch: **`feature-screenshot`** off `main`. Lanes branch off *that*, not off `main`.

---

## How this parallelizes

The phases can't be split as phases — a composer tray, a capture overlay, and a server that accepts images all consume the same types. What *can* be split is **files**, once the contract between them exists.

So: one short blocking step lands the full shared contract, then three lanes run in parallel in separate worktrees/sessions with **disjoint file ownership**, then one integration session writes the glue.

```
Step 0  foundation (blocking, ~1 session-hour)
           │
     ┌─────┼─────┐
     A     B     C          ← parallel, no shared files
   server composer capture
     └─────┼─────┘
           │
    Integration (content.ts + apiClient.ts glue, merge, live pass)
```

The one hard rule, learned from this repo's own history: **every cross-lane interface is declared in Step 0 as a real type, never as a stub.** The last parallel build here shipped a blocker where `initAskButton` called a hardcoded internal stub — it type-checked fine and would have shipped fake context. Declaring the signature up front and letting `tsc --noEmit` enforce it across lanes is what prevents a repeat.

---

## Step 0 — Foundation (sequential, blocks everything)

### 0a. Permission spike — ✅ done, answered

Measured against a real Chromium on a real `https://claude.ai` origin: `captureVisibleTab`
requires **`<all_urls>` in `host_permissions`**, and `"tabs"` buys nothing. Per-site host
permissions fail; `activeTab` fails without a gesture and is revoked on navigation, which
would make a second capture from an open panel unreliable.

`<all_urls>` is now in `manifest.json`. The full result table and the reasoning are in
`BUILD_PLAN.md` under "Screenshots in side chats".

**What this means for Lane C:** no gesture plumbing needed. Capture works from the panel
and from the toolbar equally, so the in-panel camera button is on the table after all.

### 0b. The contract commit — ✅ done

Everything below is on `feature-screenshot` already. Both packages are green:
107 extension tests, 21 server tests, typecheck and build clean on both.
A lane starts from a working tree, not a red one.

**`extension/src/shared/types.ts`** — additive, not a content-block union. `ChatMessage.content` stays `string`; images sit beside it, so `renderMarkdown` and `markdown.ts`'s "never innerHTML the model's output" invariant are untouched.

```ts
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type ImageAttachment = {
  id: string;            // crypto.randomUUID(); tray/render key
  mediaType: ImageMediaType;
  data: string;          // base64, NO "data:...;base64," prefix — the API wants raw
  width: number;
  height: number;
  byteSize: number;      // decoded bytes, for the client-side cap
};

export type ChatMessage = { role: Role; content: string; images?: ImageAttachment[] };
export type ContextPackage = { /* …existing… */ screenshot?: ImageAttachment };
export type SideChatState = { /* …existing… */ pendingImages: ImageAttachment[] };
```

**`extension/src/shared/messages.ts`** — *all* variants, including ones nothing implements yet:

```ts
CreateSideChatRequest.payload: ContextPackage & { question: string; images?: ImageAttachment[] }
SendMessageRequest.payload:    { sideChatId: string; question: string; images?: ImageAttachment[] }
CaptureRegionRequest:          { type: "CAPTURE_REGION"; payload: { rect: Rect; devicePixelRatio: number } }
StartRegionCaptureMessage:     { type: "START_REGION_CAPTURE" }   // background → content, a new direction
```

`ExtensionResponse`'s success arm gains a discriminant so the capture response isn't ambiguous: `{ ok: true; kind: "reply"; sideChatId; reply }` | `{ ok: true; kind: "image"; image: ImageAttachment }`. `shared/messages.test.ts` has a compile-time `const exhaustive: never` switch that will fail until updated — working as designed; update it here.

**`extension/src/shared/image.ts` (new, fully implemented + tested here)** — one module used by *both* bundles; `OffscreenCanvas` and `createImageBitmap` exist in the content script and the service worker alike.

- `processImage(blob): Promise<ImageAttachment>` — decode, downscale so the long edge is ≤ **1568px** (the API resizes to this anyway; more is wasted tokens and latency), re-encode.
- Encoding rule: screenshots are mostly text, and JPEG artifacts on small type are what will make the model misread. PNG first; if over **1.5 MB**, re-encode JPEG q0.9.
- Hard cap **2 MB** encoded per image, **3 images** per message, rejections surfaced through the panel's existing `renderError`.
- `blobToBase64(blob)` returning bare base64.
- `toCaptureBox(rect, dpr)` — pure rect math, testable without a canvas.

**Cross-lane interfaces** (declared now, implemented by whichever lane owns the file):

```ts
// panel.ts — Lane B implements, Lane C calls
type PanelDeps = { onSubmit(q: string, s: SideChatState, images: ImageAttachment[]): Promise<…> };
type PanelController = {
  /* …existing… */
  addImage(image: ImageAttachment): void;
  hideForCapture(): void;
  showAfterCapture(): void;
};

// regionCapture.ts — Lane C implements, integration calls
export function initRegionCapture(onCaptured: (image: ImageAttachment) => void): void;
```

**`extension/manifest.json`** — the permission from 0a, with a comment naming the call that needs it.

**`server/src/types.ts`** — `StoredImage` (= `ImageAttachment` minus the client-only `byteSize`), `Message.images?`, `SideChat.screenshot?`.

**`BUILD_PLAN.md`** — the wire format as prose. The extension and server have **independent** type files with nothing compile-checking across the boundary; that seam is where a parallel build will silently drift, so the JSON shape of `images` gets written down, not just typed twice.

**`SCREENSHOT_PLAN.md`** — this plan, committed into the repo alongside the existing `PARALLEL_PLAN.md`, so every worktree has it and each lane can read its own section without being handed context by hand.

### What Step 0 already put in files the lanes own

Kept to the minimum needed to keep the tree compiling and green — real behaviour,
no placeholders, so a lane can trust what it finds and replace it deliberately.

- **`panel.ts` (Lane B's file).** `PanelDeps.onSubmit` now takes a third `images`
  argument, `emptyState` seeds `pendingImages: []`, and `addImage` /
  `hideForCapture` / `showAfterCapture` exist and work: `addImage` stages into
  `state.pendingImages`, the other two toggle the shadow host's visibility. What
  is missing is the *tray UI* — a staged image is currently invisible. Lane B
  builds the rendering on top; the state plumbing is already correct.
- **`background.ts` (Lane C's file).** `handleRequest` is narrowed to the two
  API-calling request types and returns `kind: "reply"`, and `SEND_MESSAGE`
  forwards `images`. The `onMessage` listener returns `false` for
  `CAPTURE_REGION` rather than answering it — nothing sends it yet, and a fake
  success would be worse than no answer. Lane C replaces that arm.
- **`apiClient.ts` / `content.ts` (integrator's).** Both thread `images`
  through and narrow on `kind`, so the send path works end to end today with an
  empty array.
- **Existing test fixtures** in `apiClient.test.ts` and `background.test.ts` were
  updated for the `kind` discriminant. That is the only reason those two files
  were touched.

---

## Lane A — Server

**Worktree:** `.claude/worktrees/screenshot-server`, branch `screenshot-server` off `feature-screenshot`.
**Owns:** all of `server/**`. Touches no extension file.

- **`server/src/index.ts:34`** — `express.json({ limit: "12mb" })`. **This is the blocker that otherwise 413s every screenshot**: the default is 100 KB.
- **`server/src/routes/sideChats.ts`** — validate `images` on both POST routes before touching the store: array, ≤3, `mediaType` in the allowlist, decoded size ≤2 MB each and ≤5 MB total, `data` matching a base64 charset regex. Reuse the existing `missing: string[]` idiom (lines 16-29) so failures keep naming the specific bad field — that pattern exists precisely because a blanket error tells you nothing when a site's DOM changes.
- **Branch-point relaxation** (line 19): `selectedText` is required **unless** a `screenshot` is present; same for `parentAiResponse`, since a captured region may sit outside any turn. Purely additive — harmless while no client sends one, which is what lets this lane land independently.
- **`server/src/lib/anthropicClient.ts:20-23`** — the one place `messages[]` is built. When a turn has images, emit a content-block array instead of a string:
  ```ts
  content: [
    ...images.map((img) => ({ type: "image" as const,
      source: { type: "base64" as const, media_type: img.mediaType, data: img.data } })),
    ...(text ? [{ type: "text" as const, text }] : []),
  ]
  ```
  Images before text is the better ordering for image Q&A. Prepend `sideChat.screenshot` to the **first** user turn — stored once on the `SideChat`, not duplicated into `messages[0].images`. `@anthropic-ai/sdk@0.32.1` already types `ImageBlockParam` and a block-array `MessageParam.content` — **no SDK bump needed**.
- **`server/src/lib/contextPackage.ts`** — when `selectedText` is empty and a screenshot exists, emit a `SELECTED REGION:` line saying the user highlighted a region and it's attached as an image in their first message. The system prompt is a plain string and **cannot itself carry an image**.

**Verifiable alone:** `npm test` in `server/`, plus `curl` with a hand-rolled base64 PNG against a running server with a real key.

---

## Lane B — Composer

**Worktree:** `.claude/worktrees/screenshot-composer`, branch `screenshot-composer` off `feature-screenshot`.
**Owns:** `extension/src/content/panel.ts`, `extension/src/content/panel.css`.

- **Composer tray.** `<div class="sidechats-tray">` above the input row, one thumbnail chip per `state.pendingImages` with an × remove. Carries the `hidden` attribute when empty so the composer looks identical to today when unused.
- **Paste.** A `paste` listener on `inputEl`: walk `event.clipboardData.items` for `kind === "file" && type.startsWith("image/")`, `preventDefault`, run each through `processImage`. Note `CONTAINED_EVENTS` (panel.ts:80) does **not** include `paste` — add it, or the host page's own paste handler also acts on the image.
- **File attach.** A paperclip button in `inputRow` mirroring `sendBtn`'s construction (panel.ts:207-212, same `ICON_*` const style), driving a hidden `<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple>`.
- **Drag-drop.** `dragover` (`preventDefault`) + `drop` on `panelEl`, with a drop-target highlight class.
- **`submit()` guard, panel.ts:313.** `if (!question ...) return` becomes `if ((!question && state.pendingImages.length === 0) || ...)`. An image with no words is a legitimate "what is this?" — send an empty question and let the server's prompt carry it. Clear the tray on send.
- **`renderMessage`.** For a user bubble with `message.images`, prepend `<img>` elements built programmatically (`src = data:${mediaType};base64,${data}`), `max-width: 100%`. Still no `innerHTML` near model output.
- **Header** (panel.ts:145-169, set at :395) — when `selectedText` is empty, show a thumbnail of `ctx.screenshot` in place of the `<blockquote>`, under the same "Asking about" eyebrow.
- **Implement `addImage` / `hideForCapture` / `showAfterCapture`** from the Step 0 interface.

**Verifiable alone:** `panel.test.ts` already injects `PanelDeps` and reaches into the shadow root with stubbed `chrome.runtime.getURL`/`fetch` — a stub `onSubmit` exercises the whole composer without the network, the server, or Lane C existing.

---

## Lane C — Region capture

**Worktree:** `.claude/worktrees/screenshot-capture`, branch `screenshot-capture` off `feature-screenshot`.
**Owns:** `extension/src/content/regionCapture.ts` (new), `extension/src/background/background.ts`, `extension/src/content/context.ts`, `extension/scripts/browser-check.mjs`.

1. **Entry.** `chrome.action.onClicked` in `background.ts` → `chrome.tabs.sendMessage(tabId, { type: "START_REGION_CAPTURE" })`. Background → content is a **new message direction** this codebase doesn't have; the content-side listener is integration's (it lives in `content.ts`), so this lane ships the sender plus the `initRegionCapture` entry point it will call.
2. **Overlay.** Its own shadow host with inline styles — a handful of rules, not worth a second `web_accessible_resources` entry. Full-viewport fixed div, `cursor: crosshair`, dimmed, live rect on `mousemove`, `Escape` cancels.
3. **On mouseup:** call `hideForCapture()`, then `await` two `requestAnimationFrame`s so the hide actually paints — **otherwise the panel appears inside its own screenshot** — then send `CAPTURE_REGION`.
4. **Worker crops.** `background.ts` calls `captureVisibleTab` (full viewport, at `devicePixelRatio` scale — multiply the rect by dPR before cropping), then `fetch(dataUrl) → blob → createImageBitmap → OffscreenCanvas.drawImage(crop) → convertToBlob`, reusing `shared/image.ts`. Returns `{ ok: true, kind: "image", image }`.
5. **`context.ts`** — populate `ContextPackage.screenshot` when capture ran with no text selection. Turn extraction is unchanged: if the rect sits inside a turn, `parentUserMessage`/`parentAiResponse` still come through; if not, they're empty strings.
6. **`background.ts`** also widens `handleRequest` to forward `images` in the two existing request payloads — it's the only lane touching that file, so no conflict.

**Verifiable alone:** `regionCapture.test.ts` (rect math at dPR 1 and 2, including clamping), `background.test.ts`, and a `browser-check.mjs` case driving a real mouse drag with a stub `onCaptured` that parks the result on `window.__lastCapture`.

---

## Integration

**Checkout:** `main` working copy on `feature-screenshot`.
**Owns:** `extension/src/content/content.ts`, `extension/src/content/apiClient.ts`, `README.md`.

Both are thin glue, deliberately held back so no lane fights over them — the same split that worked for this repo's last parallel build.

- Merge A, B, C. Expect conflicts only in `package-lock.json` if any lane adds a dep (none should).
- `apiClient.ts` — thread `images` through both request types.
- `content.ts` — widen `onSubmit`, add the `START_REGION_CAPTURE` listener guarded by `isExtensionAlive()` from `runtime.ts` like every other entry point, and wire `initRegionCapture((img) => panel.addImage(img))`.
- Run the full gate, then the live pass.

---

## Running the sessions

### 1. This session does Step 0 first

Nothing can fork until the contract is committed and pushed. At the end of Step 0 I'll have run:

```bash
cd /Users/ayaansarfraz/Documents/SideChats
git checkout main && git pull
git checkout -b feature-screenshot
# …permission spike + contract commit…
git push -u origin feature-screenshot
```

### 2. Then create the three worktrees (I run these)

```bash
cd /Users/ayaansarfraz/Documents/SideChats
git worktree add -b screenshot-server   .claude/worktrees/screenshot-server   feature-screenshot
git worktree add -b screenshot-composer .claude/worktrees/screenshot-composer feature-screenshot
git worktree add -b screenshot-capture  .claude/worktrees/screenshot-capture  feature-screenshot

# node_modules and .env are NOT shared between worktrees — each lane needs its own
(cd .claude/worktrees/screenshot-server/server   && npm install)
cp server/.env .claude/worktrees/screenshot-server/server/.env    # gitignored; holds the API key
(cd .claude/worktrees/screenshot-composer/extension && npm install)
(cd .claude/worktrees/screenshot-capture/extension  && npm install)
```

Only Lane A runs a server, so nothing contends for port 3000.

### 3. What you run — one terminal per lane

```bash
# Terminal 1 — Lane A
cd /Users/ayaansarfraz/Documents/SideChats/.claude/worktrees/screenshot-server && claude

# Terminal 2 — Lane B
cd /Users/ayaansarfraz/Documents/SideChats/.claude/worktrees/screenshot-composer && claude

# Terminal 3 — Lane C
cd /Users/ayaansarfraz/Documents/SideChats/.claude/worktrees/screenshot-capture && claude
```

### 4. What you paste into each

Same shape each time, only the lane name and the ownership line change. The SessionStart hook injects the board automatically, and `SCREENSHOT_PLAN.md` is in the worktree, so this is all the context a lane needs.

**Lane A:**
> Read `SCREENSHOT_PLAN.md` — you are **Lane A (Server)**. Claim your lane on the shared board first, then implement only that section. You own all of `server/**` and must not touch a single file under `extension/`. Two other sessions are building Lane B and Lane C in parallel off the same base commit. Write the tests listed under Verification for your lane, get `npm run typecheck && npm test && npm run build` green in `server/`, push `screenshot-server`, and post a Messages line on the board saying what you shipped and anything the integrator needs to know. Do not merge to `feature-screenshot` — integration is a separate session.

**Lane B:**
> Read `SCREENSHOT_PLAN.md` — you are **Lane B (Composer)**. Claim your lane on the shared board first, then implement only that section. You own `extension/src/content/panel.ts` and `extension/src/content/panel.css` and nothing else — in particular `content.ts` and `apiClient.ts` belong to the integrator, and `background.ts`/`context.ts` belong to Lane C. Test against `panel.test.ts`'s injected `PanelDeps` with a stub `onSubmit`; you do not need the server or Lane C to exist. Get `npm run typecheck && npm test && npm run build` green in `extension/`, push `screenshot-composer`, and post a Messages line on the board. Do not merge to `feature-screenshot`.

**Lane C:**
> Read `SCREENSHOT_PLAN.md` — you are **Lane C (Region capture)**. Claim your lane on the shared board first, then implement only that section. You own `extension/src/content/regionCapture.ts` (new), `extension/src/background/background.ts`, `extension/src/content/context.ts`, and `extension/scripts/browser-check.mjs`. Do not touch `panel.ts` — call the `hideForCapture`/`showAfterCapture`/`addImage` interface declared in `shared/types.ts`; Lane B implements it. Verify with `npm run check:browser` driving a real mouse drag, not just jsdom. Get typecheck/test/build green, push `screenshot-capture`, and post a Messages line. Do not merge to `feature-screenshot`.

### 5. Integration — back in this session

```bash
cd /Users/ayaansarfraz/Documents/SideChats
git checkout feature-screenshot
git merge screenshot-server screenshot-composer screenshot-capture
```

Then the `content.ts`/`apiClient.ts` glue, the full gate, and the live chatgpt.com pass.

### Coordination notes

- `docs/board.md` is the one file all four sessions write. The canonical path is always the **main checkout** (`CLAUDE.md` has the `git rev-parse --git-common-dir` incantation); a worktree must not create its own copy. Writes there are append-only, so collisions are unlikely but each lane should re-read before writing.
- Lanes stay off `feature-screenshot` — nobody merges but the integrator, so the base commit stays stable under all three.
- If a lane discovers the Step 0 contract is wrong, it posts to the board rather than editing `shared/types.ts` locally. One lane silently changing a shared type is how the other two get a merge that type-checks but doesn't work.

---

## Verification

Tests are co-located `*.test.ts` (Vitest in both packages; extension runs jsdom pinned to `https://chatgpt.com/`).

**Per lane, before handing off**
- **Step 0:** `extension/src/shared/image.test.ts` — **jsdom has neither `createImageBitmap` nor `OffscreenCanvas`**, so stub them in-file or add a `@vitest-environment-options` override; don't let this silently no-op. Cover the downscale threshold, the PNG→JPEG fallback, the 2 MB rejection. Plus the updated `messages.test.ts` `never` switch.
- **Lane A:** extend `sideChats.test.ts`'s supertest + `vi.mock("../lib/anthropicClient.js")` harness — images forwarded; oversize/too-many/bad-`mediaType` rejected with the field named; screenshot-only creation succeeds with empty `selectedText`. New `anthropicClient.test.ts` (mock the SDK) for block construction, image-before-text ordering, and the screenshot landing on the first user turn. `contextPackage.test.ts` for the `SELECTED REGION:` branch.
- **Lane B:** `panel.test.ts` — paste adds a chip, × removes it, image-only submit is allowed, tray clears after send, `addImage` renders.
- **Lane C:** `regionCapture.test.ts`, `background.test.ts`, and the new `check:browser` case.

**Integration — real browser.** `npm run check:browser` end to end: drag → capture → panel → send. **This layer matters more than usual here** — the board's own post-mortem records that the last two shipped bugs were both invisible to jsdom and slipped through fixtures, and a capture path that silently returns a blank or panel-contaminated image is exactly that shape of bug.

**Integration — manual, live chatgpt.com** (`npm run dev` in `server/`, load `extension/dist/` unpacked):
1. Drag a region over a chart in an assistant reply → panel opens with the thumbnail as the branch point → ask "what does this show?" → real reply.
2. In a text-seeded side chat: paste a screenshot, attach a PNG, drag-drop one → all three land in the tray → send → the reply references the image.
3. Send a follow-up with *no* image and confirm the server still resends the stored one (the API is stateless; the extension not resending is the whole point of server-side storage).
4. Confirm the panel does not appear inside its own screenshot.

**Gates before merge:** `npm run typecheck && npm test && npm run build` in both packages, plus `npm run check:browser` and `npm run check:invalidation` in `extension/`.

---

## Notes

- Each lane claims its row in `/Users/ayaansarfraz/Documents/SideChats/docs/board.md` before its first edit and posts a Messages line on ship — `CLAUDE.md` requires it and it's how the other sessions see each other.
- **Where this will hurt if it hurts:** the extension↔server wire format, because nothing type-checks across it, and the panel/capture interaction, because focus and visibility bugs only appear once both files are in one tree. The last parallel build here found a focus-trap that neither lane could see alone. Budget real time for integration rather than treating it as a merge.
- Lanes A and B are worth splitting on their own even if you don't run all three — they share literally nothing. Lane C is the one that benefits least from isolation, since integration has to re-verify it in a browser anyway.
- Server images live in the in-memory `Map` under the existing 30-minute idle TTL, so growth is bounded by that and the 30-req/min rate limit. Worth a line in `BUILD_PLAN.md`'s storage section, not a code change.
