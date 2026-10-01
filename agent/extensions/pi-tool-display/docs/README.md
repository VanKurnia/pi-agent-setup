# pi-tool-display (local fork) — docs

Local fork of `pi-tool-display@0.5.0` that also vendors **pi-style's boxed tool renderers**
(`@quandev104/pi-style@0.2.11`), so tool calls can render either upstream's compact rows or
pi-style's boxed cards — while `pi-zentui` keeps owning the editor, footer, user messages and
selector borders.

## Two rendering modes

| Mode | Selected by | Renderer |
| --- | --- | --- |
| compact (default) | `boxedToolCalls: false` | upstream `pi-tool-display` rows (no box) |
| pi-style cards | `boxedToolCalls: true` | vendored pi-style boxed cards for **every** tool |

Exception: a tool listed in `passthroughTools` (JSON-only escape hatch, default `[]`, unused in this
repo) skips the boxed path entirely and keeps its own `renderCall`/`renderResult`. For the `subagent`
tool the fork instead ships a dedicated card (`subagent-card.ts`) that draws the same payload inside
the box chrome — per-agent rows, live tool calls, metrics and the settled output.

Toggle in-session: `/tool-display` → *pi-style boxed tool cards*, or edit
`agent/extensions/pi-tool-display/config.json` and `/reload`.

## Doc map

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — layers, render flow, file map, state and flags.
- [`INTEGRATION.md`](INTEGRATION.md) — how the pi-style port was performed, exact commands, routing table.
- [`PITFALLS.md`](PITFALLS.md) — every mistake made in this work, root cause, fix, and how to spot a regression.
- [`MAINTENANCE.md`](MAINTENANCE.md) — upstream sync procedure, verification gates, open items, do-not-touch list.
- `../FORK.md` — short changelog (fork point + every intentional delta). Keep it updated.

## Fast orientation for a new session

1. Read `../FORK.md`, then `ARCHITECTURE.md` (10 min).
2. Verify the tree is healthy:
   - `cd ~/.pi && npx tsc --noEmit` → only the pre-existing `agent/extensions/pi-cbm/test/...` error is allowed; **zero** errors mentioning `pi-tool-display`.
   - `npx eslint agent/extensions/pi-tool-display/` → exit 0.
3. Never touch `agent/zentui.json`, `agent/settings.json` packages, or `agent/npm/*` as part of this
   extension's work (see the do-not-touch list in `MAINTENANCE.md`).
