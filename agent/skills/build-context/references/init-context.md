# Init Context

The target is the whole workspace: what a session must know before its first real task.

## Steps

1. **Existing context** — review what pi already injected: `AGENTS.md`, `AGENTS.override.md`, and `CLAUDE.md` from `cwd` up to the git root, plus the global `~/.pi/agent/AGENTS.md`. Then find the `AGENTS.md`/`CLAUDE.md` below `cwd` that pi does not auto-load, and read them.
2. **Name the session** — `rename_session` with `Base {cwd name} | {dd-mm-yy}` (today's date, so cwd `~/.pi` on 23 Nov 2026 becomes `Base .pi | 23-11-26`). Do it before the briefing so every grounded session is identifiable in the session selector.
3. **Architecture, top level only** — root listing, manifests (`package.json`, `*.config.*`), entry points, and a trusted `.pi/settings.json` when present.
4. **Brief** — workspace rules and constraints; repo structure and stack; invariants and conventions to respect; contradictions or absent context files.

## Completion

End with `Ready to proceed — confirm to start?`, or `Missing context — confirm fallback?` when no workspace context file exists.
