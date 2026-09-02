# SideChats

Contextual side conversations for ChatGPT and Claude — "browser tabs for AI chats."

Long AI conversations are linear. When you hit a term you don't understand, you either ask in the main chat (polluting it) or open a new chat (losing the context). SideChats lets you highlight any text in an assistant reply, hit **Ask**, and open a small side panel that already knows what you're looking at — without touching the parent conversation.

Not everything worth asking about is text. Click the toolbar icon to drag a box around a chart, a diagram, or a table that lost its structure, and ask about the picture instead. Images can also be pasted, dropped, or attached to any message in a side chat.

## How it works

```
chatgpt.com / claude.ai        Chrome extension            Local server
  content script      ──msgs──▶  service worker  ──HTTP──▶  Express  ──▶ Anthropic API
  (selection, Ask button,        (network relay)            (side-chat store,
   Shadow DOM panel)                                         prompt builder)
```

The side chat is sent the selected text, the parent AI response, and the preceding user message. The extension never holds an API key — the key stays on the server.

Screenshots follow the same path. The content script draws the selection overlay but can't photograph the tab — `captureVisibleTab` is a `chrome.tabs` API — so it hands the worker a rectangle, and the worker captures, crops, and downscales before anything is sent. Images are uploaded once and stored with the side chat; the server re-sends them to the API on every turn, so a long thread never re-uploads the same bytes. This is why the manifest asks for `<all_urls>`: Chrome grants tab capture on nothing narrower. The content script itself still only runs on ChatGPT and Claude.

- `extension/` — Manifest V3 Chrome extension. Per-site adapters for ChatGPT and Claude, vanilla TS, no framework.
- `server/` — Express + Anthropic SDK. In-memory side-chat store; `POST /api/side-chats`, `POST /api/side-chats/:id/messages`, `DELETE /api/side-chats/:id`, `GET /health`.
- `docs/` — the shared agent board used to coordinate parallel Claude Code sessions.

## Running it

```bash
# 1. Server
cd server
npm install
cp .env.example .env      # add your ANTHROPIC_API_KEY
npm run dev               # http://localhost:3000

# 2. Extension
cd extension
npm install
npm run build             # or: npm run dev  (watch mode)
```

Then load `extension/dist/` as an unpacked extension at `chrome://extensions` (Developer mode on) and open ChatGPT or Claude. Highlight text in an assistant message and click **Ask**, or click the SideChats toolbar icon and drag a box around anything on the page.

## Tests

```bash
cd server    && npm test
cd extension && npm test        # plus: npm run typecheck, npm run check:browser
```

`check:browser` is the one that matters most: it loads the built extension into a real Chromium, drives a genuine mouse drag, and inspects the captured pixels — including a check that the panel isn't inside its own screenshot, which no amount of jsdom can tell you.

## Status

MVP. Side chats live in memory only — nothing persists across a server restart or page reload, images included. No accounts, no publishing to the Web Store.

See `PROJECT.md` for product context and `BUILD_PLAN.md` for the plan.
