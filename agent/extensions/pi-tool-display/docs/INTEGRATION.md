# Integration — how the pi-style port was performed

Reproduce this from scratch if the vendored copy is ever lost. Commands run in Git Bash from `~/.pi`.

## 1. Vendor pi-style's tool surface (no install, no code rewrite)

```bash
cd /tmp && rm -rf pistyle && mkdir pistyle && cd pistyle
npm pack @quandev104/pi-style@0.2.11 >/dev/null && tar -xzf *.tgz

SRC=/tmp/pistyle/package/extension-src/pi-style
DST="C:/Users/Ivan Kurniawan/.pi/agent/extensions/pi-tool-display/src/pistyle"
mkdir -p "$DST/features/tools" "$DST/shared"
cp -r "$SRC/features/tools/boxed" "$DST/features/tools/"
cp "$SRC/shared/ansi.ts" "$SRC/shared/box.ts" "$SRC/shared/elapsed.ts" \
   "$SRC/shared/render-budget.ts" "$SRC/shared/split-diff.ts" "$SRC/shared/theme-extras.ts" "$DST/shared/"
```

Result: 24 files, ~436 KB. Their internal imports (`../../../shared/box.js`, `./batch.js`) resolve
unchanged because the directory shape is preserved.

**Do not** `pi install` pi-style. Installing it would also claim the status line, editor, startup
header, messages and theme, all of which belong to `pi-zentui` here.

## 2. Make it compile under this repo's stricter tsconfig

`tsconfig.json` here enables `strict`, `noUnusedLocals`, `noUnusedParameters`; pi-style builds with
looser settings. Remove the dead declarations it tolerated (all genuinely unreferenced):

```bash
cd agent/extensions/pi-tool-display/src/pistyle
# Delete each file's ranges in DESCENDING line order, one sed pass per range, so
# earlier ranges keep their line numbers. Verify with tsc after each file.
sed -i '240,270d' shared/ansi.ts   # _ansi256ToRgb + _ANSI_16_RGB (single pass: one range covers both)
sed -i '791,792d' shared/box.ts    # _footerIsError / _footerIsPartial
sed -i '304,331d' shared/box.ts    # _tightBoxWidth
sed -i '292,294d' shared/box.ts    # BOX_WIDTH_CACHE_MAX_ENTRIES (comment + const)
```

Six declarations total. Apply deletions in one `sed` range per block (sequential `sed -i` calls
shift line numbers — that mistake cost a broken file mid-session; see `PITFALLS.md`).

After the copy, also re-apply the fork's visual delta: tool cards are filled with
`TOOL_CARD_BG_HEX` (`#1a1b26`) via `applyCardBackground` in `shared/box.ts`, and `split-diff.ts` blends
diff rows from the same base (see `FORK.md`).

Verify: `npx tsc --noEmit 2>&1 | grep pistyle` → no output.

## 3. Bridge (`src/pistyle-bridge.ts`)

Responsibilities, in order:

1. `syncPistyleRenderConfig(config)` — pushes `previewLines`, `expandedPreviewMaxLines`,
   `ZENTUI_NERD_FONTS`, `collapseAfterTurn` into pi-style's `setToolsRenderConfig`, guarded by four
   integer comparisons so a steady-state render costs nothing.
2. `primeTheme(theme)` — `setFullTheme(theme)` only when the theme object identity changes.
3. Tool routing:

| Tool | Renderer |
| --- | --- |
| `read`, `write`, `edit`, `bash` | pi-style dispatcher (dedicated boxed card) |
| `powershell` | alias → `bash` card |
| every other tool | pi-style **boxed fallback** card (`renderFallbackCall`/`renderFallbackResult`) |

Routing deliberately bypasses pi-style's `grep`/`find`/`ls` renderers: those are *boxless* tree
panels, and this setup wants one framed look for every tool.

4. `resetPistyleRegistries()` — clears pi-style's registries plus the bridge's guards.

## 4. Registration seams (`src/tool-overrides.ts`)

`wrapToolRenderersForPistyle(tool, getConfig)` replaces a tool's `renderCall`/`renderResult` with a
flag-gated dispatcher (falls through to the compact renderer when the flag is off). Installed at:

- `registerRuntimeTool()` — this extension's own built-in overrides
- `applyToolDisplayDecorationInPlace()` — MCP/custom tool decoration (also fed from the pending
  decoration drain and the `pi.registerTool` interceptor)
- the all-tools sweep `registerMcpToolOverrides()` (retries at 25/75/150/300 ms)
- a `WeakSet` guard prevents repeated wrapping from stacking wrappers

## 5. Renderer-selection patch (`src/pistyle-tool-patch.ts`)

The seam that actually covers *every* tool. Wraps
`ToolExecutionComponent.prototype.getCallRenderer` / `getResultRenderer`:

- the selector takes **no arguments** and returns the tool's renderer → call it with `[]` once, then
  wrap the *returned renderer* (this distinction was a real bug — see `PITFALLS.md`)
- flag on → return pi-style's card for the tool name on the component (`instance.toolName`)
- flag off → call the original renderer unchanged
- `neutralizeToolContainer(instance)` zeroes container padding and neutralises its background
- install returns `false` if the methods are missing (pi internals moved) → the extension then relies
  on the registered renderers only; restore happens on reload

Wired in `src/index.ts` right after `registerToolDisplayOverrides(...)`.

## 6. Config flag

Add `boxedToolCalls: boolean` (default `false`) through `types.ts` → `config-store.ts` →
`config-modal.ts` → `presets.ts`, mirroring the existing `collapseAfterTurn` plumbing. Default off
keeps upstream behavior for anyone who does not opt in.

## Verification after any change to this integration

```bash
cd ~/.pi
npx tsc --noEmit | grep -v pi-cbm          # must print nothing
npx eslint agent/extensions/pi-tool-display/
```

Then in a live session: `/reload`, `/tool-display` → confirm the flag, and run one tool per path —
`read`, `bash`, `powershell`, `ffgrep`, `fffind`, `recall`, `git_status`, `write`, `edit`.
