# SideChats

Read `PROJECT.md` for product context and `BUILD_PLAN.md` for the MVP plan.

## Coordinate with other agents

This repo often has several Claude Code sessions in parallel (main checkout + git worktrees). They do **not** share a chat. They share `docs/board.md`.

1. At session start, read the canonical board (injected by a SessionStart hook; still open the file if you need the latest).
2. Claim a lane before you edit anything.
3. Do not touch files another lane lists under **Owns**.
4. Append a **Messages** line when you finish, block, or need another agent to know something.

Canonical path — use this even from a worktree:

```bash
python3 -c "import os,subprocess; p=os.path.abspath(subprocess.check_output(['git','rev-parse','--git-common-dir'],text=True).strip()); print(os.path.join(os.path.dirname(p),'docs','board.md'))"
```

Human view: open `docs/index.html` via `python3 -m http.server 8765 --directory docs`.
