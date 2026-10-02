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

| File | Change |
| --- | --- |
| `agent/settings.json` | removed `npm:pi-tool-display` from `packages` |
| `agent/npm/package.json` | removed the `pi-tool-display` dependency |
| `agent/npm/package-lock.json` | removed the `pi-tool-display` entry |
| `agent/npm/node_modules/pi-tool-display` | deleted (reinstallable) |

Do not re-add the dependency: with both copies present, two extensions would register renderers for
the same tools.

## Contents

The module graph is deliberately **flat**. Pi loads extensions through jiti, which costs roughly
**19 ms per module** regardless of size, so splitting 500 KB of code across 50 files cost more than
the code itself. The boot-time graph is now 8 modules; everything else is loaded lazily.

Boot-static (transpiled on every boot):

| File | KB | Contents |
| --- | --- | --- |
| `src/pistyle/features/tools/boxed/index.ts` | 288 | every boxed tool renderer (read/write/edit/find/grep/ls/bash/git/gh/batch/turn-summary/fallback) and the dispatcher |
| `src/pistyle/shared/index.ts` | 114 | box drawing, ANSI, diff, render budget, theme extras |
| `src/wiring.ts` | 57 | the bridge, the renderer patch, MCP decoration, thinking labels, user-message box |
| `src/fork-cards.ts` | 41 | db-query, OCR and subagent cards |
| `src/support.ts` | 20 | config store, tool metadata, debug logger, agent dir, disposables |
| `src/index.ts` | 2 | the extension entry point |

Lazy (only on `/tool-display`): `config-modal.ts`, `zellij-modal.ts`, `settings-inspector-modal.ts`,
`presets.ts`, `modal-icons.ts`, `render-utils.ts`.

- `src/pistyle/` — vendored `@quandev104/pi-style@0.2.11` boxed renderers and shared modules.
- `src/wiring.ts` — maps this extension's config, theme, and Pi's renderer arguments onto the ported
  renderers, and patches `ToolExecutionComponent`'s renderer resolution so tools owned by other
  extensions are covered too.
- `src/wiring.ts` also publishes the `pi-tool-display.api.v1` global and promotes MCP tools with
  model-facing metadata (label, description, prompt snippet, parameters).
- `FORK.md` — every intentional delta versus upstream.
- `docs/` — architecture, integration recipe, pitfalls, maintenance.
- `config.json` — live configuration, edited by `/tool-display`.

The merged files carry `// ==== // from: <original>` section markers naming their source modules, so
you can still find the code you are looking for. `.script/merge.mjs` and `.script/merge-finish.mjs`
regenerate a merge from a list of sources if you need to split one back apart.

## Use

- `/tool-display` opens the settings modal. `previewLines` sets how much output a card shows while
  collapsed; `collapseAfterTurn` folds a finished turn's tool calls into one summary line.
- `/reload` applies extension changes.

## Updating

- Upstream `pi-tool-display`: `npm pack pi-tool-display@<version>` and cherry-pick file-by-file. Note
  that the compact renderer path and the config fields that fed it were removed here; only the MCP
  decoration in `wiring.ts` is still derived from upstream, plus the vendored pistyle tree.
- `pi-style`: re-run the port steps in `docs/INTEGRATION.md`, then re-apply the fork deltas listed in
  `FORK.md`. The ported files land inside the merged `pistyle/shared/index.ts` and
  `pistyle/features/tools/boxed/index.ts`; look for the `// from:` marker naming the original
  pi-style module and edit inside that section, or split the file back with `.script/merge.mjs`.
