# pi-tool-display — local extension

Local fork of [`pi-tool-display@0.5.0`](https://github.com/MasuRii/pi-tool-display) (MIT) with
[pi-style](https://www.npmjs.com/package/@quandev104/pi-style)'s boxed tool renderers vendored in.
This directory **is** the install: the extension is no longer pulled from npm or listed as a plugin.

## Why it is local

- Upstream 0.5.0 declares `@earendil-works/pi-tui` / `pi-coding-agent` peers `^0.74–^0.80`; this
  workspace runs Pi 0.99.1, so the vendored copy carries the compatibility adaptations.
- The fork holds deliberate behavior and visual changes (pi-style boxed cards, card background,
  metric colors, bash call expansion) that cannot live in a versioned dependency.
- Pi discovers extensions in `agent/extensions/`, so a local directory needs no `packages` entry.

## What was cleaned up

| File                                     | Change                                        |
| ---------------------------------------- | --------------------------------------------- |
| `agent/settings.json`                    | removed `npm:pi-tool-display` from `packages` |
| `agent/npm/package.json`                 | removed the `pi-tool-display` dependency      |
| `agent/npm/package-lock.json`            | removed the `pi-tool-display` entry           |
| `agent/npm/node_modules/pi-tool-display` | deleted (reinstallable)                       |

Do not re-add the dependency: with both copies present, two extensions would register renderers for
the same tools.

## Contents

The module graph is deliberately **flat** — four files. Pi loads extensions through jiti, which
costs roughly **19 ms per module** regardless of size, so splitting 500 KB of code across 50 files
cost more than the code itself. The merges below traded file count for bytes; the bytes are the same.

| File                          | KB  | Contents                                                                                                                                    |
| ----------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pistyle/index.ts`        | 257 | every boxed tool renderer (read/write/edit/find/grep/ls/bash/git/gh/batch/fallback) and the dispatcher                                      |
| `src/pistyle/shared/index.ts` | 112 | box drawing, ANSI, diff, render budget, theme extras                                                                                        |
| `src/wiring.ts`               | 93  | renderer resolver registration, the pi-style bridge, MCP decoration, thinking labels, user-message box, and the db-query/OCR/subagent cards |
| `src/index.ts`                | 13  | the extension entry point: lifecycle, `TOOL_DISPLAY_CONFIG`, tool metadata, debug logger, cleanup registry                                  |

Nothing is loaded lazily.

- `src/pistyle/` — vendored `@quandev104/pi-style@0.2.11` boxed renderers and shared modules.
- `src/wiring.ts` — registers the renderer resolver through `pi.registerToolRenderer` (the native
  replacement for the old `ToolExecutionComponent` patch), maps this extension's config, theme and
  Pi's render arguments onto the ported renderers, and routes the fork-owned db-query/OCR/subagent
  cards.
- `src/wiring.ts` also publishes the `pi-tool-display.api.v1` global and promotes MCP tools with
  model-facing metadata (label, description, prompt snippet, parameters).
- `src/index.ts` — the manifest entry (`package.json` → `pi.extensions` → `./src/index.ts`): the
  extension factory plus the merged support sections behind it.
- `FORK.md` — every intentional delta versus upstream.
- `docs/` — architecture, integration recipe, pitfalls, maintenance.

The merged files carry `// from: <original module>` section markers naming their source modules, so
you can still find the code you are looking for. The merged files are the source of truth now -
edit them in place.

## Use

- `/reload` applies extension changes.
- Card sizing is not a runtime setting any more: edit `TOOL_DISPLAY_CONFIG` in `src/index.ts` (a
  frozen constant) and `/reload`.
- To disable the extension, toggle it off in `/extensions` (the workspace `ext-mgr` renames the
  manifest entry `src/index.ts` → `src/index.ts.disabled`). Doing it by hand works the same way: pi
  resolves the paths in `package.json`'s `pi.extensions`, and with no `index.ts`/`index.js` fallback in
  this directory nothing loads.

## Updating

- Upstream `pi-tool-display`: `npm pack pi-tool-display@<version>` and cherry-pick file-by-file. Note
  that the compact renderer path and the config fields that fed it were removed here; only the MCP
  decoration in `wiring.ts` is still derived from upstream, plus the vendored pistyle tree.
- `pi-style`: re-run the port steps in `docs/INTEGRATION.md`, then re-apply the fork deltas listed in
  `FORK.md`. The ported files land inside the merged `pistyle/shared/index.ts` and
  `pistyle/index.ts`; look for the `// from:` marker naming the original
  pi-style module and edit inside that section.
