# SideChats

Contextual side conversations for ChatGPT and Claude — "browser tabs for AI chats."

Long AI conversations are linear. When you hit a term you don't understand, you either ask in the main chat (polluting it) or open a new chat (losing the context). SideChats lets you highlight any text in an assistant reply, hit **Ask**, and open a small side panel that already knows what you're looking at — without touching the parent conversation.

## How it works

```
chatgpt.com / claude.ai        Chrome extension            Local server
  content script      ──msgs──▶  service worker  ──HTTP──▶  Express  ──▶ Anthropic API
  (selection, Ask button,        (network relay)            (side-chat store,
   Shadow DOM panel)                                         prompt builder)
```

The side chat is sent the selected text, the parent AI response, and the preceding user message. The extension never holds an API key — the key stays on the server.

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

Then load `extension/dist/` as an unpacked extension at `chrome://extensions` (Developer mode on), open ChatGPT or Claude, highlight text in an assistant message, and click **Ask**.

## Tests

```bash
cd server    && npm test
cd extension && npm test        # plus: npm run typecheck, npm run check:browser
```

## Status

MVP. Side chats live in memory only — nothing persists across a server restart or page reload. No accounts, no publishing to the Web Store.

See `PROJECT.md` for product context and `BUILD_PLAN.md` for the plan.
