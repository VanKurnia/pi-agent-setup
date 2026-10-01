# Architecture

## Layout

```
agent/extensions/pi-tool-display/
  index.ts                     extension entry (loads config, wires everything)
  package.json                 pi extension manifest (no runtime deps)
  config.json                  live config (registerToolOverrides, boxedToolCalls, …)
  FORK.md                      changelog of every delta vs upstream 0.5.0
  docs/                        this documentation
  src/
    index.ts                   real entry: config load/save, command wiring, session events
    tool-overrides.ts          built-in tool overrides + compact renderers + pi-style registration seams
    bash-display.ts            upstream 0.5.0 verbatim (compact bash renderer)
    diff-renderer.ts           upstream 0.5.0 verbatim (compact diff renderer)
    config-store.ts, config-modal.ts, presets.ts, types.ts   config schema/persistence/UI
    pistyle-bridge.ts          THIS fork: config/theme mapping + tool routing into pi-style
    pistyle-tool-patch.ts      THIS fork: ToolExecutionComponent renderer-selection patch
    pistyle/                   vendored pi-style 0.2.11 (see below)
  tool-display-api-consumer.js/.d.ts   upstream adapter for other extensions
```

`src/pistyle/` is vendored from `@quandev104/pi-style@0.2.11`:

```
src/pistyle/
  features/tools/boxed/   read, write, edit, bash, grep, find, ls, git, gh, batch, quick-edit,
                          turn-summary, output-tree, fallback, command-shape, session-config,
                          shared, index (dispatcher)
  shared/                 box, ansi, elapsed, render-budget, split-diff, theme-extras
```

Two fork deltas exist (see `FORK.md`): six dead declarations removed for this repo's
`noUnusedLocals`, and the card background pinned to the tokyo-night base (`#1a1b26`,
`TOOL_CARD_BG_HEX` / `applyCardBackground` in `shared/box.ts`; `split-diff.ts` blends diff rows
from the same base) instead of pi's status-driven fill. Everything else is pi-style source unmodified.

## Render flow (pi-style mode)

```
pi renders a tool block
        │
        ▼
ToolExecutionComponent.getCallRenderer()/getResultRenderer()      ← patched by pistyle-tool-patch.ts
        │  (flag on)
        ▼
pistyle-bridge.renderPistyleToolCall / renderPistyleToolResult
        │  config sync (cheap, guarded) + theme prime (identity-guarded)
        │  tool-name routing
        ├── read | write | edit | bash   → pi-style dispatcher (dedicated boxed card)
        ├── powershell                   → alias → bash card
        └── everything else              → pi-style boxed fallback card
                    │
                    ▼
        src/pistyle/features/tools/boxed/*  (box frame, title in top border,
                                             footer in bottom border, registries)
```

With the flag **off**, the patch returns pi's original renderer, i.e. upstream `pi-tool-display`
compact rows. Nothing in the compact path depends on `src/pistyle/`.

## Expansion

Expanding a block (click, or Ctrl+O) sets pi's `expanded` flag, which pi passes to **both**
renderers. Result renderers honor it through their preview budgets. On the call side, the write
card reveals more of the written content and the bash card reveals the whole command (collapsed
bash keeps the command head plus an omitted-line note). Every other call card is already complete:
the fallback card prints all arguments and the summary cards show a single path/pattern line.

## Colors

Status is carried by the title glyph (`✓` success / `✗` error / `◌` running), the frame, and the
running label (green). The tool name uses the theme accent (blue). Measured values use the metric
identity colors — value in `warning` yellow, unit in `accent` blue (`formatMetricParts` /
`formatElapsedMetric` in `shared/box.ts`) — and the result divider label is `warning` yellow. The
elapsed ticker refreshes every 100 ms, so the running value ticks in milliseconds.

## Why the renderer-selection patch exists

`pi.getAllTools()` returns `ToolInfo` — `name`/`description`/`parameters`/`promptGuidelines` only
(pi's `dist/core/extensions/types.d.ts`). It carries **no** `renderCall`/`renderResult`, so a sweep
over it cannot attach renderers to tools that were registered before this extension loaded
(`ffgrep`, `fffind`, built-in `powershell`, `recall`, …). pi-style solves this by patching the
component that resolves renderers; this fork does the same, guarded:

- install only if both prototype methods exist; otherwise report `false` and fall back to the
  registered renderers
- restore the originals on `session_shutdown` (reason `reload`) and before re-installing
- the returned renderer falls through to the original renderer when the flag is off
- `neutralizeToolContainer` zeroes pi's container padding and clears pi's native status fill
  (`contentBox`/`selfRenderContainer`, plus `contentText` for tools with no definition); the card
  itself is then filled with the base background (`TOOL_CARD_BG_HEX`)

Registered renderers (`wrapToolRenderersForPistyle` in `src/tool-overrides.ts`) remain as a
belt-and-braces path: they cover tools registered *after* load (via the `pi.registerTool`
interceptor) and any environment where the patch cannot install.

## State and lifecycle

- `resetPistyleRegistries()` (bridge) → pi-style's `resetGrepRegistry`, `resetBatchRegistry`,
  `resetBashTreeRegistry`, `resetTurnRegistry`, plus the bridge's config/theme guards.
  Called on `session_start` and `session_shutdown`.
- pi-style keeps per-call registries keyed by `toolCallId`; pi-style's own coordinator also resets
  them on message boundaries — **not ported** (see open items in `MAINTENANCE.md`).
- pi-style's elapsed ticker is a single shared 1s interval, active only while a tool runs.

## Config surface added by this fork

| Key | Where | Effect |
| --- | --- | --- |
| `boxedToolCalls` | `types.ts`, `config-store.ts`, `config-modal.ts`, `presets.ts` | selects pi-style cards vs compact rows |
| `collapseAfterTurn` | same files, plus `pistyle-bridge.ts` | mapped into pi-style's session config; **only effective in pi-style mode** |

Mapping into pi-style's own session config (`pistyle-bridge.ts`):

| pi-style field | source |
| --- | --- |
| `maxCollapsedLines` | `previewLines` |
| `maxExpandedLines` | `expandedPreviewMaxLines` |
| `nerdFonts`, `batchOpenGlyph` | `ZENTUI_NERD_FONTS !== "0"` |
| `collapseAfterTurn` | `collapseAfterTurn` |

## Performance contract

Steady-state per render, per visible tool block, this fork adds: 4 integer comparisons (config
guard), 1 identity comparison (theme guard), 3 property writes (`neutralizeToolContainer`), plus the
pre-existing `getConfig()` allocation that upstream's own renderers also pay. No filesystem I/O
(pi's `Theme` exposes `name`/`sourcePath`, so pi-style's theme-extras cache takes its fast path),
no timers, no allocation in the guarded paths. Keep it that way: do not add per-render I/O.
