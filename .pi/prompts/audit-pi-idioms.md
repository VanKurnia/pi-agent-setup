---
description: Audit our extensions against the pi core type declarations and rewrite what we hand-rolled in an API core already has
argument-hint: "<scope: extension folder, glob, or all>"
---

# Audit ${1:-all of our extensions} against pi core

Read the declarations of every `@earendil-works/pi-*` package we depend on, in
full, before touching code: they are the truth and our memory of their API is
not. Never edit them and never re-declare them. The house rules these APIs serve
are in @AGENTS.md (Extensions Creations) and @agent/prompts/simplify-changes.md.

Docs beside the code: `node_modules/@earendil-works/pi-coding-agent/docs` and
[pi.dev](https://pi.dev).

## Where core already wins

- a tool assembled from string parsing or regex over arguments →
  `pi.registerTool` with a TypeBox schema
- a timer, watcher or poll over session files and our own state → the
  `pi.on(...)` event for that moment (`tool_call`, `tool_result`, `input`,
  session and agent events)
- state written to our own JSON next to the extension → `pi.appendEntry` with a
  renderer, or `store`/`load` in codemode
- child-process plumbing, shell quoting, PATH hunting → `pi.exec`
- keys, chords or an editor stub wired by hand → `pi.registerShortcut`,
  `pi.registerCommand`, `ctx.ui.*`
- a panel, dialog, toast or status line drawn from scratch → `ctx.ui.custom`,
  `ctx.ui.confirm|select|input`, widgets/status/footer, `pi-tui` components
- transcript text patched after the fact → `pi.registerMessageRenderer`,
  `pi.registerEntryRenderer`, `pi.registerToolRenderer`,
  `pi.registerMarkdownTransformer`
- token counting, compaction or context trimming of our own →
  `ctx.getContextUsage`, `ctx.compact`
- session or tree surgery on files → `ctx.newSession`, `ctx.fork`,
  `ctx.navigateTree`, `pi.setSessionName`, `pi.setLabel`
- config keys read from `process.env`, a model or tool set switched by hand →
  `pi.registerFlag`, `pi.setModel`, `pi.setActiveTools`
- a helper that already exists in `agent/extensions/shared/` or in the package's
  exports → that helper
- defensive parsing of args, messages or events inside our own trusted code →
  the declared types

## How to change it

Prefer deleting our version over wrapping it. Reuse an existing extension before
adding a mechanism, and put shared behavior in one place.

Where core has no answer, leave the code and say so: no invented API, no shim
hiding the gap, no vendored copy of a package we already depend on.

Keep each change behavior-preserving. Ask before one that alters what a person
sees or how a tool behaves.

## Finish

```powershell
npm run check
node .script/bench-extensions.mjs
```

Report, per file: what changed, what was left alone and why, what `check` and
the bench printed, and what only a running session can confirm. A change without
a passing check is not finished.
