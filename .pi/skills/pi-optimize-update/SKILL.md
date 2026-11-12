---
name: pi-optimize-update
description: Audit the active extensions in ~/.pi/agent/extensions against newer pi releases and propose updates that raise code quality or performance.
disable-model-invocation: true
metadata:
  version: "1.1.0"
  argument-hint: "[all | <extension>] [perf | quality]"
---

# Optimize Update

Read-only audit: the run ends with a proposal table and one question. Nothing is edited, renamed, or disabled before the user picks items.

## Ground truth

The installed package sits at `$PI_MANAGED_INSTALL_ROOT` (default `~/.pi/agent/install`) → `releases/<current-version>/node_modules/@earendil-works/pi-coding-agent`. Its `CHANGELOG.md`, `docs/`, and `dist/*.d.ts` are the runtime, its docs, and its signatures. Every API claim is checked there.

## 1. Upstream delta

Compare the releases API (or the repo's `CHANGELOG.md`) against `current-version`. Keep only lines an extension can act on: an API name, a breaking change, a performance note, a new event or option, a TUI capability.

Nothing newer: say so in one line, then audit the active set against `docs/` alone.

## 2. Active set

Under the extensions directory (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`, plus project `.pi/extensions`), an active extension is a top-level `.ts`/`.js` file, a `<dir>/index.ts`, or a manifest entry in `package.json` → `pi.extensions`. `.disabled` files, `shared/`, and plain module folders are not extensions. `settings.json` `packages` entries are updated with `pi update --extensions`, not audited. `all` is the default, `<extension>` narrows to one.

## 3. Match a release line to a location

1. calls something deprecated or removed in the delta;
2. hand-rolls what a new API provides — net deletion, the best quality win;
3. misses a new option or event that removes work: caching, incremental render, batching;
4. reimplements `extensions/shared/`, or keeps a render hack a TUI addition replaces.

`perf` narrows to 3, `quality` to 1, 2 and 4. Style nits and speculative rewrites are out of scope.

## 4. Verify, then propose

Each candidate needs its signature confirmed in the installed `docs/` or `d.ts`, its current usage at a real `file:line`, and proof the old code still works today. Unverified is dropped, not softened.

Order by value ÷ effort:

| # | Extension | Release item | Change | Value | Effort | Risk | Evidence |

Then, per top item, 2–3 sentences: current code, proposed code, why it is better. Close with what was not audited and one `ask_user_question` on what to implement.
