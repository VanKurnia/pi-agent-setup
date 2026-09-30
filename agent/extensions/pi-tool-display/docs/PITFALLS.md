# Pitfalls — mistakes made here, root causes, fixes

Read this before changing the integration. Each entry: symptom → root cause → fix → how to catch it again.

## 1. `theme.fg("<unknown>")` throws and silently kills the renderer

**Symptom** — boxed cards never appeared; markers never appeared; nothing from the extension was
visible, yet no error surfaced in the session.

**Root cause** — pi's theme resolves color names through `tokenAnsi`, which **throws**
`Unknown theme color: <token>` (`dist/modes/interactive/theme/theme.js`). Two invalid names were used
in a row: `"white"` (not a schema key) and `"brightText"` (a *variable* inside `tokyo-night.json`,
not a theme color key). Every boxed header render threw; pi catches renderer errors and falls back to
its native rendering, so the failure was invisible.

**Fix** — use only keys from pi's theme schema (`dist/modes/interactive/theme/theme-schema.json`);
`toolTitle` is a required key and maps to `brightText` (#c0caf5) in `tokyo-night`. Validate every
token used by this extension against both the schema and `agent/themes/tokyo-night.json`.

**Detect again** — if a card silently stops rendering, grep for `theme.fg("`/`theme.bg("` in the
touched code and confirm each token exists in both files. Never trust a token because it "looks
like" a color name.

## 2. Width bail-out disabled the box exactly where it was tested

**Symptom** — long `bash` commands (the ones actually being tested) had no border, while short ones
did.

**Root cause** — the first, hand-rolled box returned the line unboxed when `width + 4 > columns`.
`process.stdout.columns` in pi's runtime is not a reliable width signal, and long commands exceed it.

**Fix** — the hand-rolled box was deleted entirely in favour of pi-style's box primitives, which wrap
content inside the frame. If a custom box is ever reintroduced: never silently degrade, wrap instead.

## 3. Re-deriving a design instead of vendoring it

**Symptom** — the first boxed attempt was called "ugly"; it looked nothing like pi-style.

**Root cause** — the look was approximated from pi-style's *documentation* (rounded corners, glyph
sets) instead of its source. Details that carry the aesthetic — 2-space side padding, title embedded
in the top border, metadata in the bottom border, dim frame, status background tint — were all missed.

**Fix** — `npm pack` the package and copy the real source (`INTEGRATION.md`). Copy the code, adapt
only what the compiler forces.

## 4. Two implementations of the same feature (dead duplication)

**Symptom** — after the pi-style port landed, the extension still carried a glyph-marker set and a
home-grown turn-summary/collapse (~250 lines) from an earlier "pi-style-inspired" pass.

**Root cause** — the earlier pass shipped features that the port made redundant; nothing removed them.

**Fix** — deleted `src/glyph-tokens.ts`, all marker prefixes, the turn-summary tracker/wrapper, and
the now-dead `context` parameters they required. pi-style's own `turn-summary.ts` does the job.
Rule: when a vendored implementation lands, delete the home-grown equivalent in the same change.

## 5. "Harmless" glyph substitution silently changed upstream behavior

**Symptom** — diff bars rendered as `▎` instead of upstream's `▌`, and the code-divider logic lost
its `hashlineGutter || indicatorMode !== "classic" ? "│ " : "│"` branch (a functional regression, not
cosmetic).

**Root cause** — a "token swap" edit in `diff-renderer.ts` replaced expressions with constants,
dropping surrounding logic.

**Fix** — `bash-display.ts` and `diff-renderer.ts` were restored to upstream `0.5.0` **verbatim**
(only an unused-import prune kept for `noUnusedLocals`). Treat those two files as upstream-owned; any
change must be justified in `FORK.md`.

## 6. Sweeping `pi.getAllTools()` cannot attach renderers

**Symptom** — `ffgrep`, `fffind`, `powershell`, `recall` had no box while `read`/`bash` did.

**Root cause** — `pi.getAllTools()` returns `ToolInfo`: `name`, `description`, `parameters`,
`promptGuidelines` only (`dist/core/extensions/types.d.ts`). No `renderCall`/`renderResult`, so
mutating those objects does nothing. Tools registered before this extension loaded (and built-ins
registered by pi core) therefore never got renderers.

**Fix** — patch `ToolExecutionComponent.prototype.getCallRenderer`/`getResultRenderer`
(`pistyle-tool-patch.ts`), which is the layer pi-style itself patches. Keep the registration-seam
wrapping as the fallback path for environments where the patch cannot install.

## 7. Selector vs renderer: wrong argument flow in the patch

**Symptom** — patch installed but produced no change (or wrong arguments) for every tool.

**Root cause** — pi's `getCallRenderer()` takes **no arguments** and *returns* the renderer; the first
patch version passed the render arguments into the selector instead of into the returned renderer.

**Fix** — call the selector once with `[]`, then invoke the renderer it returns with
`(args, theme, context)` / `(result, options, theme, context)`.

## 8. pi-style's search renderers are boxless

**Symptom** — aliasing `ffgrep` → `grep` produced a tree panel with no frame.

**Root cause** — pi-style renders `grep`/`find`/`ls` as *boxless* tree panels by design.

**Fix** — only `read`/`write`/`edit`/`bash` (plus the `powershell` alias) use dedicated renderers;
everything else goes to the boxed fallback card, so every tool is framed the same way.

## 9. Per-render config/theme work in the bridge

**Symptom** — none visible, but every render allocated a fresh config object and re-resolved the theme
name; if pi's theme object had ever lacked `name`/`sourcePath`, `setFullTheme` would have fallen back
to reading and parsing `~/.pi/agent/settings.json` **on every render**.

**Fix** — `syncPistyleRenderConfig` early-returns on four integer comparisons; `primeTheme` re-primes
only when the theme object identity changes; both guards reset in `resetPistyleRegistries()`.

**Rule** — nothing in the render path may do I/O or allocate per call. pi-style itself follows this.

## 10. Cutting ANSI text by raw length corrupts the box

**Symptom** — a bash card shows a garbage glyph (`<?>`) next to the literal `… (truncated)`, and
that line's right border sits one or more columns off the rest of the box.

**Root cause** — the line clamp cut by *raw string length* (`line.slice(0, 2000)`). When the cut
lands inside an SGR sequence, the half-written escape stays in the string: terminals render it as
garbage, and the width parser either swallows the following text or miscounts it, so the box fill
overshoots or falls short. Reproduced deterministically: a mostly-escape line rendered **4 columns
wide in a 60-column box**.

**Fix** — `clampRenderLine` (`shared/render-budget.ts`) now truncates through `safeTruncateToWidth`,
which is escape-aware; `bash.ts`'s duplicate `clampLineLength` was deleted in favour of it. Rule:
never slice, pad or measure ANSI text with `length`/`slice` — go through the render-budget helpers.

**Verify without the TUI** — compile the port and render components with a stub theme:

```bash
cd ~/.pi && mkdir -p .tmp-repro && printf '{"type":"module"}' > .tmp-repro/package.json
npx tsc agent/extensions/pi-tool-display/src/pistyle/features/tools/boxed/bash.ts \
  --outDir .tmp-repro --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck
```

Then import `bashTool` (and `boxLine` / `clampRenderLine` / `safeWrapTextWithAnsi`) from
`.tmp-repro`, pass a theme stub whose `fg` emits real truecolor escapes, render at several widths
and assert every line's `visibleWidth` equals the box width and that no line contains a stray
`\x1b` after stripping complete sequences. Delete `.tmp-repro` when done.

## 11. Process mistakes worth not repeating

- **Repo-wide gates were red before the work started** (`pi-cbm` has a committed `TS6133` error and
  `no-undef` failures in fixtures). Two executor runs stopped on them. Gate **scoped** to
  `agent/extensions/pi-tool-display/` and treat the `pi-cbm` line as a known baseline.
- **Sequential `sed -i` deletions** shift line numbers; deleting two blocks with absolute ranges in
  two passes corrupted `ansi.ts`. Delete ranges in one pass per file, descending, and re-run `tsc`.
- **Config drift**: `config.json` was reset to defaults once during testing (all tool overrides `true`,
  `hidden` output modes, `enableNativeUserMessageBox: true`) — cause unknown (modal/preset). Check the
  live config before debugging renderer behavior; it silently changes what you are looking at.
