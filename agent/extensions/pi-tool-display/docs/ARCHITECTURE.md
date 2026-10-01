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
    db-query-card.ts           THIS fork: boxed card for db-viewer's query tools
    subagent-card.ts           THIS fork: boxed card for the subagent tool
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

`src/pistyle/**` carries the fork deltas listed in `FORK.md`: the six dead declarations removed for
this repo's `noUnusedLocals`, the card background pinned to the tokyo-night base (`#1a1b26`,
`TOOL_CARD_BG_HEX` / `applyCardBackground` in `shared/box.ts`; `split-diff.ts` blends diff rows from
the same base) instead of pi's status-driven fill, the status-colored frames and running glyphs, and
the git/gh status plumbing. Everything else is pi-style source unmodified, and a re-port has to
re-apply that list (`MAINTENANCE.md`).

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
        ├── query_sqlite | query_mysql   → db-query-card.ts (fork card, see below)
        ├── subagent                     → subagent-card.ts (fork card, see below)
        └── everything else              → pi-style boxed fallback card
                    │
                    ▼
        src/pistyle/features/tools/boxed/*  (box frame, title in top border,
                                             footer in bottom border, registries)
```

With the flag **off**, the patch returns pi's original renderer, i.e. upstream `pi-tool-display`
compact rows. Nothing in the compact path depends on `src/pistyle/`.

## subagent card (fork addition)

`subagent` routes to `src/subagent-card.ts`. Its own renderer (per-agent progress rows) is bypassed
by the patch, and the fallback card printed only the call args plus the literal content string
`(running...)` — the whole progress payload in `details.results` was dropped, so a running subagent
told the user nothing about what it was doing.

- Call card: `➔ Subagent · parallel · scout, worker` header, then one line per requested agent/task
  (title, then the task's first 5 lines; expanded shows all).
- Result card: one row per agent — status glyph, name, title, `N tools · N tok · elapsed` — then that
  agent's recent tool calls (6 collapsed, all expanded), the live `▸ current tool` line while running,
  its latest prose line, and any error. Settled runs append the concatenated output under a rule, and
  the footer shows `elapsed · ok/total agents · tokens`. The running footer is the fork's standard
  `󰐊 Running · <elapsed>`.
- Budget: collapsed lines are capped by a card-local `COLLAPSED_RUN_LINES` (24), **not**
  `previewLines` (8) — with the shared preview budget a two-agent run truncated before the output
  section and the card advertised `… more lines omitted` instead of showing the run.
- `passthroughTools` is the generic escape hatch for tools whose own renderers should survive; it is
  unused in this repo because this card gives the richer result (box chrome *and* the payload).

Routing lives in `pistyle-bridge.ts` next to the db-viewer card, for the same re-port reason.

## db-viewer query card (fork addition)

`query_sqlite` / `query_mysql` (db-viewer) route to `src/db-query-card.ts` instead of the fallback
card. Two reasons: the fallback *call* card prints every argument — including the credentials inside
`connectionString` — and db-viewer's own `renderResult` (a markdown box table) is bypassed by the
patch, so the table look would be lost.

- Call card: `➔ Query MySQL · <target>` header, SQL lines (5 collapsed / all expanded), `Max rows`
  when the argument is set. `redactConnectionTarget()` masks the password
  (`mysql://user:***@host/db`) and leaves URIs without one untouched; the authority splits on its
  **last** `@`, so a raw `@` inside a password cannot leak the tail as the host.
- Result card: `Rows` divider, pi's Markdown renderer for the table (10-line collapse, mirrored from
  `agent/extensions/shared/markdown.ts` so this fork stays self-contained), and an `elapsed · N rows`
  footer instead of the word count. The body is a plain line-builder: the Markdown renders per paint,
  the same cost db-viewer's own renderer pays today.

Routing lives in `pistyle-bridge.ts`, not in the vendored dispatcher registry: a pi-style re-port
replaces `src/pistyle/features/tools/boxed/index.ts` wholesale, and the bridge is documented as
re-port-independent (`MAINTENANCE.md`).

## Expansion

Expanding a block (click, or Ctrl+O) sets pi's `expanded` flag, which pi passes to **both**
renderers. Result renderers honor it through their preview budgets. On the call side, the write
card reveals more of the written content and the bash card reveals the whole command (collapsed
bash keeps the command head plus an omitted-line note). Every other call card is already complete:
the fallback card prints all arguments and the summary cards show a single path/pattern line.

## Colors

Status is carried by the title glyph (`✓` success / `✗` error / `󱦟` running) and by the frame
color: `boxFrameColor` in `shared/box.ts` renders a settled box fully in the theme `success` green,
a failed one in `error` red, and keeps the frame dim while the call is pending, running or streaming
(`isPartial`/`isPending` gate it — `running` stays true after a call settles). The frame tracks the
*tool result*, not a payload's own conclusion: a `gh run view` card can be green while its log shows
a failed job, whose `✗` glyph carries that state. The git per-file frames use the same helper for
their top border and body. The running label (`󰐊 Running · 12.4s`, see `formatBoxedRunningStatus`) is
green and ticks in the footer. Both running glyphs are Nerd Font icons — `RUNNING_TITLE_GLYPH`
(U+F199F, exported for the batch and gh rows) and the module-local footer glyph U+F040A — and
width-1, so the frame alignment math is unchanged; they do sit outside `render-budget.ts`'s
simple-glyph set, so lines carrying them are measured by grapheme segmentation. The title glyph also
marks running batch panels/members (`batch.ts`) and gh run statuses (`gh.ts`; cancelled/skipped stay
a dim `-`). The tool name
uses the theme accent (blue). Measured values use the metric identity colors — value in `warning`
yellow, unit in `accent` blue (`formatMetricParts` / `formatElapsedMetric` in `shared/box.ts`) — and
the result divider label is `warning` yellow. `formatElapsedParts` promotes elapsed units (ms → s → m
→ h: `812ms`, `15.28s`, `2m5s`, `1h2m`) for every footer, metric row and running label. The elapsed
ticker refreshes every 100 ms, so the running value ticks in milliseconds.

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
- pi-style's elapsed ticker is a single shared 100 ms interval, active only while a tool runs.

## Config surface added by this fork

| Key | Where | Effect |
| --- | --- | --- |
| `boxedToolCalls` | `types.ts`, `config-store.ts`, `config-modal.ts`, `presets.ts` | selects pi-style cards vs compact rows |
| `passthroughTools` | `types.ts`, `config-store.ts`, `presets.ts`, `pistyle-bridge.ts` | escape hatch: listed tools skip the boxed path and keep their own renderers (default `[]`, unused here — `subagent` has a dedicated card) |
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
guard), 1 identity comparison (theme guard), 2-3 boolean comparisons (frame color,
`boxFrameColor`), 3 property writes (`neutralizeToolContainer`), plus the pre-existing `getConfig()`
allocation that upstream's own renderers also pay. Lines carrying a running glyph (titles, live
footers, batch rows) leave `render-budget.ts`'s simple-glyph fast path for grapheme segmentation —
the price of the PUA icons, restorable by adding their codepoints to `isSimpleWidthOneGlyphCode`.
No filesystem I/O
(pi's `Theme` exposes `name`/`sourcePath`, so pi-style's theme-extras cache takes its fast path),
no timers, no allocation in the guarded paths. Keep it that way: do not add per-render I/O.
