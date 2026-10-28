# pi-tool-display (local fork) — docs

Local fork of `pi-tool-display@0.5.0` that also vendors **pi-style's boxed tool renderers**
(`@quandev104/pi-style@0.2.11`), so every tool call renders as a boxed card — while `pi-zentui` keeps
owning the editor, footer, user messages and selector borders.

## Two rendering modes

| Mode              | Selected by | Renderer                                                                |
| ----------------- | ----------- | ----------------------------------------------------------------------- |
| compact (removed) | —           | upstream `pi-tool-display` rows (no box); deleted 2026-09-30            |
| pi-style cards    | always      | vendored pi-style boxed cards for **every** tool; the only presentation |

A few tools bypass the dispatcher and get fork-owned cards routed from `src/wiring.ts`, next to its
pi-style bridge: `subagent` (`isSubagentTool`), db-viewer's query tools (`isDbQueryTool`) and the OCR
tools (`isOcrTool`). A tool that needs its own presentation gets a card route there — one line per
direction — rather than a passthrough list.

Card sizing is a frozen constant, not a setting: edit `TOOL_DISPLAY_CONFIG` in `src/index.ts` and
`/reload`. To disable the extension, toggle it off in `/extensions` (the workspace `ext-mgr` renames
the manifest entry `src/index.ts` → `src/index.ts.disabled`); renaming it by hand does the same, since
pi's loader then finds nothing to load.

## Doc map

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — layers, render flow, file map, state and lifecycle.
- [`INTEGRATION.md`](INTEGRATION.md) — how the pi-style port was performed, exact commands, routing table.
- [`PITFALLS.md`](PITFALLS.md) — every mistake made in this work, root cause, fix, and how to spot a regression.
- [`MAINTENANCE.md`](MAINTENANCE.md) — upstream sync procedure, verification gates, open items, do-not-touch list.
- `../FORK.md` — short changelog (fork point + every intentional delta). Keep it updated.

## Fast orientation for a new session

1. Read `../FORK.md`, then `ARCHITECTURE.md` (10 min).
2. Verify the tree is healthy:
    - `cd ~/.pi && npx tsc --noEmit` → 4 errors, all in `agent/extensions/skills-hint.ts`; **zero** errors mentioning `pi-tool-display`.
    - `npx vp lint agent/extensions/pi-tool-display/` → exit 0.
    - `npx vp fmt --check agent/extensions/pi-tool-display/` → exit 0.
3. Never touch `agent/zentui.json`, `agent/settings.json` packages, or `agent/npm/*` as part of this
   extension's work (see the do-not-touch list in `MAINTENANCE.md`).
