---
description: Bootstrap context with workspace rules and architecture
---

Before starting any task, build a grounded understanding of this workspace.

## Steps

1. **Verify injected context** — review project context already in system prompt (`AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md` from `cwd` up to git root, plus global `~/.pi/agent/AGENTS.md`). Then use `find` to locate any `AGENTS.md`/`CLAUDE.md` in subdirectories below `cwd` that pi doesn't auto-load, and `read` them.
2. **Snapshot architecture** — top-level only: if `get_architecture` is available (CBM-enabled workspace), use it; otherwise `ls` root and `read` manifests (`package.json`, `*.config.*`) and entry points. Do not descend into `node_modules`/vendored code. Optionally `read` trusted `.pi/settings.json` if present.
3. **Synthesize** — brief the session:
   - Workspace rules and constraints
   - Repo structure and tech stack
   - Invariants and conventions to respect
   - Open questions if context files are missing or contradictory

4. **Name the session** — call the `rename_session` tool with `Base {current directory name} | {dd-mm-YY}` using today-date (2-digit day, month, year). Example: cwd ending in `.pi` on 23 Sep 2026 becomes `Base .pi | 23-09-26`. Do this before the briefing so every grounded session is identifiable in the session selector.

## Constraints

- Do not assume rules — verify by reading.
- If no workspace context files exist, state that and fall back to `README.md`/`package.json`.
- Briefing only — do not start the actual task until confirmed.

## Completion

Report as concise bullets and end with `Ready to proceed — confirm to start?` or `Missing context — confirm fallback?`
