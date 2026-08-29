#!/usr/bin/env python3
"""Inject the shared agent board into Claude Code context."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def main_root() -> Path:
    raw = subprocess.check_output(["git", "rev-parse", "--git-common-dir"], text=True).strip()
    return Path(raw).resolve().parent


def board_path() -> Path:
    return main_root() / "docs" / "board.md"


def event_name() -> str:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        payload = {}
    return payload.get("hook_event_name") or os.environ.get("CLAUDE_HOOK_EVENT", "SessionStart")


def full_context(path: Path) -> str:
    body = path.read_text() if path.exists() else "(board.md is missing — create docs/board.md on the main checkout)"
    return (
        "SHARED AGENT BOARD — other Claude sessions use this file to coordinate.\n"
        f"Canonical path (edit this even from a worktree): {path}\n"
        "Read it before you start. Claim a lane. Post a message when you ship, block, or hand off.\n"
        "Do not edit files another lane owns.\n\n"
        f"{body}"
    )


def summary_context(path: Path) -> str:
    if not path.exists():
        return f"Agent board missing at {path}. Create it before overlapping other sessions."
    stat = path.stat()
    lines = [ln for ln in path.read_text().splitlines() if ln.startswith("### ")]
    names = ", ".join(ln.replace("### ", "", 1).strip() for ln in lines) or "(none)"
    return (
        f"Agent board last updated {int(stat.st_mtime)} at {path}. "
        f"Active lanes: {names}. Re-read that file before touching files another agent owns."
    )


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "full"
    path = board_path()
    hook_event = event_name()
    text = full_context(path) if mode == "full" else summary_context(path)
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": hook_event,
                    "additionalContext": text,
                }
            }
        )
    )


if __name__ == "__main__":
    main()
