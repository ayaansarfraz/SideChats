# Agent instructions

Read `PROJECT.md` before making architectural or product decisions.
Read the shared agent board before doing any work.

## Shared board (required)

All Claude and Cursor sessions coordinate through one file on the **main checkout**:

`docs/board.md`

Live view: `docs/index.html` (serve with `python3 -m http.server 8765 --directory docs`).

Even inside a git worktree, edit the main-checkout copy. Resolve it with:

```bash
python3 -c "import os,subprocess; p=os.path.abspath(subprocess.check_output(['git','rev-parse','--git-common-dir'],text=True).strip()); print(os.path.join(os.path.dirname(p),'docs','board.md'))"
```

Rules:

1. Read the board at session start.
2. Claim a lane (status, files you own, timestamp) before you start.
3. Do not edit files another lane owns — leave a message instead.
4. Append a Messages line when you ship, get blocked, or hand off.
5. Set status to `idle` or `done` when you stop.

## Current objective

Build an MVP browser extension for contextual side chats inside AI chat interfaces.

## Priorities

1. Simple architecture
2. Fast iteration
3. ChatGPT support first
4. Highlight text → Ask → sidebar
5. Preserve parent conversation context
6. Avoid premature infrastructure

## Do not build yet

- knowledge graphs
- complex embeddings infrastructure
- multi-user collaboration
- sophisticated branch visualization
- native desktop app
- full ChatGPT replacement

When making a product or technical decision, optimize for validating the core interaction first.
