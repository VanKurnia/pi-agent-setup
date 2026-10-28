# Architecture

## Layout

Four modules, no lazy imports. `package.json`'s `pi.extensions` points at `./src/index.ts`; that file
imports `./wiring.js`, which imports the two vendored pi-style files.

```
agent/extensions/pi-tool-display/
  package.json                 pi extension manifest: pi.extensions = ["./src/index.ts"]
  FORK.md                      changelog of every delta vs upstream 0.5.0
  CHANGELOG.md                 release notes
  docs/                        this documentation
  src/
    index.ts                   entry: lifecycle, frozen TOOL_DISPLAY_CONFIG, tool metadata,
                               debug logger, cleanup registry
    wiring.ts                  renderer-resolver registration, pi-style bridge, tool/MCP
                               decoration, thinking labels, user-message box, and the
                               db-query/OCR/subagent cards
    pistyle/index.ts           vendored pi-style 0.2.11: every boxed renderer + the dispatcher
    pistyle/shared/index.ts    vendored pi-style 0.2.11: box, ANSI, diff, render budget,
                               theme extras
```

Inside the merged files, `// from: <module>` markers name the original modules:

| File                          | Sections                                                                                                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pistyle/index.ts`        | `command-shape`, `output-tree`, `session-config`, `shared`, `gh`, `git`, `bash`, `batch`, `edit`, `fallback`, `find`, `grep`, `ls`, `read`, `write`, `index` (dispatcher)                                                         |
| `src/pistyle/shared/index.ts` | `ansi`, `elapsed`, `render-budget`, `theme-extras`, `box`, `split-diff`                                                                                                                                                           |
| `src/wiring.ts`               | `thinking-label`, `tool-decoration`, the six `user-message-box*` sections, `db-query-card`, `ocr-card`, `subagent-card`, plus the two bridge sections that carry the pi-style config/theme mapping and the renderer-patch history |
| `src/index.ts`                | `ansi-utils`, `types`, `tool-metadata`, `debug-logger`, `disposable`, `index.ts (entry helper)`                                                                                                                                   |

`src/pistyle/**` carries the fork deltas listed in `FORK.md`: the six dead declarations removed for
this repo's `noUnusedLocals`, the card background pinned to the tokyo-night base (`#1a1b26`,
`TOOL_CARD_BG_HEX` / `applyCardBackground` in the `box` section of `shared/index.ts`; the `split-diff`
section blends diff rows from the same base) instead of pi's status-driven fill, the status-colored
frames and running glyphs, and the git/gh status plumbing. Everything else is pi-style source
unmodified, and a re-port has to re-apply that list (`MAINTENANCE.md`).

## Render flow

```
pi renders a tool block
        │
        ▼
pi.registerToolRenderer(resolver)         ← registerPistyleToolRenderer (src/wiring.ts)
        │  resolver returns { renderShell: "self", renderCall, renderResult }
        │  both renderers are wrapped by withOutputPad(context.outputPad)
        ▼
renderPistyleToolCall / renderPistyleToolResult
        │  frozen render config applied once at registration;
        │  theme primed only when the theme instance changes
        │  tool-name routing
        ├── read | write | edit | bash   → pi-style dispatcher (dedicated boxed card)
        ├── powershell                   → alias → bash card
        ├── query_sqlite | query_mysql   → db-query card (fork card, see below)
        ├── ocr_review | ocr_scan        → OCR card (fork card, see below)
        ├── subagent                     → subagent card (fork card, see below)
        └── everything else              → pi-style boxed fallback card
                    │
                    ▼
        src/pistyle/index.ts  (box frame, title in top border,
                               footer in bottom border, registries)
```

`renderShell: "self"` makes pi wrap the component in its bare `selfRenderContainer` — no padding,
no status fill — instead of the default `contentBox`, so the card owns its own frame and background.
There is no second rendering mode: a tool with no dedicated card gets the boxed fallback card.

## subagent card (fork addition)

`subagent` routes to the subagent card in `src/wiring.ts`. Its own renderer (per-agent progress
rows) is bypassed by the resolver, and the fallback card printed only the call args plus the literal
content string `(running...)` — the whole progress payload in `details.results` was dropped, so a
running subagent told the user nothing about what it was doing.

- Call card: `➔ Subagent · single · <agent>` header, then the task text
  (title, then the task's first 5 lines; expanded shows all). `details` carries
  `{mode:'single', pane, session, reused}`.
- Result card: one row per agent — status glyph, name, title, `N tools · N tok · elapsed` — then that
  agent's recent tool calls (6 collapsed; expanded lifts the per-agent cap and the output cap up to
  the expanded render budget), the live `▸ current tool`
  line while running, its latest prose line, and any error. Settled runs append the concatenated output
  under a rule, and the footer shows `elapsed · ok/total agents · tokens`. The running footer is the
  fork's standard `󰐊 Running · <elapsed>` — until the first partial result paints, the call card reads
  `… Waiting for output…`, because pi-style's first-partial pass is intentionally empty.
- Status classification is shared with the legacy subagents widget (`subagents/src/widget.ts`, legacy): only
  `running`/`pending` come from the reported status, and a terminal row is judged by its exit code.
- Budget: collapsed lines are capped by a card-local `COLLAPSED_RUN_LINES` (24), **not**
  `previewLines` (8) — with the shared preview budget a two-agent run truncated before the output
  section and the card advertised `… more lines omitted` instead of showing the run.
- A tool that needs its own presentation gets a card route in `src/wiring.ts` (one line per
  direction), next to the db-viewer and OCR cards.

Routing lives in `src/wiring.ts` next to the pi-style bridge, for the same re-port reason.

## db-viewer query card (fork addition)

`query_sqlite` / `query_mysql` (db-viewer) route to the db-query card in `src/wiring.ts` instead of
the fallback card. Two reasons: the fallback _call_ card prints every argument — including the
credentials inside `connectionString` — and db-viewer's own `renderResult` (a markdown box table) is
bypassed by the resolver, so the table look would be lost.

- Call card: `➔ Query MySQL · <target>` header, SQL lines (5 collapsed / all expanded), `Max rows`
  when the argument is set. `redactConnectionTarget()` masks the password
  (`mysql://user:***@host/db`) and leaves URIs without one untouched; the authority splits on its
  **last** `@`, so a raw `@` inside a password cannot leak the tail as the host.
- Result card: `Rows` divider, pi's Markdown renderer for the table (10-line collapse, mirrored from
  `agent/extensions/shared/markdown.ts` so this fork stays self-contained), and an `elapsed · N rows`
  footer instead of the word count. The body is a plain line-builder: the Markdown renders per paint,
  the same cost db-viewer's own renderer pays today.

Routing lives in `src/wiring.ts`, not in the vendored dispatcher registry: a pi-style re-port
replaces `src/pistyle/index.ts` wholesale, and the bridge section is documented as
re-port-independent (`MAINTENANCE.md`).

## Expansion

Expanding a block (click, or Ctrl+O) sets pi's `expanded` flag, which pi passes to **both**
renderers. Result renderers honor it through their preview budgets. On the call side, the write
card reveals more of the written content and the bash card reveals the whole command (collapsed
bash keeps the command head plus an omitted-line note). Every other call card is already complete:
the fallback card prints all arguments and the summary cards show a single path/pattern line.

## Colors

Status is carried by the title glyph (`✓` success / `✗` error / `󱦟` running) and by the frame
color: `boxFrameColor` in the `box` section of `shared/index.ts` renders a settled box fully in the theme `success` green,
a failed one in `error` red, and keeps the frame dim while the call is pending, running or streaming
(`isPartial`/`isPending` gate it — `running` stays true after a call settles). The frame tracks the
_tool result_, not a payload's own conclusion: a `gh run view` card can be green while its log shows
a failed job, whose `✗` glyph carries that state. The git per-file frames use the same helper for
their top border and body. The running label (`󰐊 Running · 12.4s`, see `formatBoxedRunningStatus`) is
green and ticks in the footer. Both running glyphs are Nerd Font icons — `RUNNING_TITLE_GLYPH`
(U+F199F, exported for the batch and gh rows) and the module-local footer glyph U+F040A — and
width-1, so the frame alignment math is unchanged; they do sit outside `render-budget.ts`'s
simple-glyph set, so lines carrying them are measured by grapheme segmentation. The title glyph also
marks running batch panels/members (`batch.ts`) and gh run statuses (`gh.ts`; cancelled/skipped stay
a dim `-`). The tool name
uses the theme accent (blue). Measured values use the metric identity colors — value in `warning`
yellow, unit in `accent` blue (`formatMetricParts` / `formatElapsedMetric` in the `box` section of `shared/index.ts`) — and
the result divider label is `warning` yellow. `formatElapsedParts` promotes elapsed units (ms → s → m
→ h: `812ms`, `15.28s`, `2m5s`, `1h2m`) for every footer, metric row and running label. The elapsed
ticker refreshes every 100 ms, so the running value ticks in milliseconds.

## Why a renderer resolver exists

`pi.getAllTools()` returns `ToolInfo` — `name`/`description`/`parameters`/`promptGuidelines` only
(pi's `dist/core/extensions/types.d.ts`). It carries **no** `renderCall`/`renderResult`, so a sweep
over it cannot attach renderers to tools that were registered before this extension loaded
(`ffgrep`, `fffind`, built-in `powershell`, `recall`, …). Pi ≥ 1.0.1 exposes the seam natively:

- `registerToolRenderer(resolver: ToolRendererResolver)` (`types.d.ts:1256`) — the resolver is asked
  for a tool's renderers by name, whichever extension registered the tool.
- `ToolRenderers = Pick<AnyToolDefinition, "renderShell" | "renderCall" | "renderResult">`
  (`types.d.ts:521`) is what the resolver returns.
- `renderShell?: "default" | "self"` (`types.d.ts:469`) picks the container pi builds around the
  renderer; `"self"` selects the bare `selfRenderContainer` and leaves the frame to the card.

`wrapToolRenderersForPistyle` remains a belt-and-braces path: it routes the renderers a _decorated_
tool already carries through the boxed path, so decorated and undecorated tools present the same way.
Decorated means "went through the `pi.registerTool` interceptor", which only sees tools registered
after this extension loaded.

One prototype patch does survive — the native user-message box. `patchNativeUserMessagePrototype`
(in `src/wiring.ts`) rewrites `UserMessageComponent`'s render to draw the fork's border, is gated by
`enableNativeUserMessageBox`, and is restored on reload.

## State and lifecycle

- `resetPistyleRegistries()` (wiring) → pi-style's `resetGrepRegistry`, `resetBatchRegistry`,
  `resetBashTreeRegistry`, plus the primed-theme guard. Called on `session_start` and
  `session_shutdown`.
- pi-style keeps per-call registries keyed by `toolCallId`; pi-style's own coordinator also resets
  them on message boundaries — **not ported** (see open items in `MAINTENANCE.md`).
- pi-style's elapsed ticker is a single shared 100 ms interval, active only while a tool runs.

## Config surface added by this fork

There is no config file and no command any more: `TOOL_DISPLAY_CONFIG` in `src/index.ts` is a frozen
constant (`previewLines: 8`, `expandedPreviewMaxLines: 4000`, `collapseAfterTurn: false`,
`enableNativeUserMessageBox: true`). `applyPistyleRenderConfig()` pushes it into pi-style once per
registration:

| pi-style field                | source                                        |
| ----------------------------- | --------------------------------------------- |
| `maxCollapsedLines`           | `TOOL_DISPLAY_CONFIG.previewLines`            |
| `maxExpandedLines`            | `TOOL_DISPLAY_CONFIG.expandedPreviewMaxLines` |
| `collapseAfterTurn`           | `TOOL_DISPLAY_CONFIG.collapseAfterTurn`       |
| `nerdFonts`, `batchOpenGlyph` | `ZENTUI_NERD_FONTS !== "0"`                   |

Change the constant in the source and `/reload`; nothing else reads a config file.

## Performance contract

Steady-state per render, per visible tool block, this fork adds: 1 identity comparison (the primed
theme), 2-3 boolean comparisons (frame color, `boxFrameColor`), and — only for a tool that sets
`outputPad` — the `withOutputPad` wrapper's `String.repeat` and an intercept-and-reindent pass over
the rendered lines. The frozen render config is applied once per registration, so the render path
reads no config at all. Lines carrying a running glyph (titles, live
footers, batch rows) leave `render-budget.ts`'s simple-glyph fast path for grapheme segmentation —
the price of the PUA icons, restorable by adding their codepoints to `isSimpleWidthOneGlyphCode`.
No filesystem I/O
(pi's `Theme` exposes `name`/`sourcePath`, so pi-style's theme-extras cache takes its fast path),
no timers, no allocation in the guarded paths. Keep it that way: do not add per-render I/O.
