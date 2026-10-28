# Maintenance

## Verification gates (run after every change)

```bash
cd ~/.pi
npx tsc --noEmit                            # 4 errors, all in agent/extensions/skills-hint.ts
npx vp lint agent/extensions/pi-tool-display/
npx vp fmt --check agent/extensions/pi-tool-display/
npm test                                    # 15/18 test files; the same 3 failures stay
node .script/smoke-tool-display.mjs         # 12 renderer paths, 0 failed
```

Live check: `/reload`, then run one tool per path — `read`, `bash`, `powershell`, `ffgrep`,
`fffind`, `recall`, `git_status`, `write`, `edit`, `query_sqlite`, `ocr_review`, `subagent`.

There is no unit-test harness for this extension, so verification is compile + lint + `fmt` + the
smoke script + a manual render pass.

## Upstream sync

**pi-tool-display (upstream fork point: `0.5.0`)**

- Only the MCP decoration is still derived from upstream (the `tool-decoration` section of
  `src/wiring.ts`: tool metadata, the `pi-tool-display.api.v1` global, the `pi.registerTool`
  interceptor). Compare that section against a fresh `npm pack pi-tool-display@<newer>` and
  cherry-pick deliberately; record each delta in `FORK.md`.
- Never reinstall the npm package: `agent/settings.json` packages and `agent/npm/package.json` must
  stay free of `pi-tool-display` (the local directory is the only copy). If `install.sh` /
  `.script/update.sh` re-adds it, that is a bug in the updater — fix the allowlist there.
- `agent/npm/node_modules/pi-tool-display` must not exist.

**pi-style (vendored version: `@quandev104/pi-style@0.2.11`)**

- Re-port = re-run the `npm pack` + `cp` steps in `INTEGRATION.md`, then re-apply every fork delta
  listed in `FORK.md` until `tsc` is clean. Today that is: the six dead-declaration removals, the
  card-background delta (`TOOL_CARD_BG_HEX` fill in the `box` section + the same base in
  `split-diff`), the status-colored frames and running glyphs in the `box` section (plus the batch
  and gh rows using them), the metric colors and elapsed unit promotion (per-pair unit coloring),
  the bash call expansion, the ANSI-safe line clamp, the git/gh status plumbing, the removed
  quick-edit routes and the lazily built word table. Re-applying only the first two silently reverts
  the rest.
- The port lands inside `src/pistyle/index.ts` and `src/pistyle/shared/index.ts`; the fork's own
  bridge sections in `src/wiring.ts` are version-independent and must **not** be regenerated.
- Keep the port surface to the `features/tools/boxed/*` sections of `src/pistyle/index.ts` and the
  `shared/{ansi,box,elapsed,render-budget,split-diff,theme-extras}` sections of
  `src/pistyle/shared/index.ts`. Do not start pulling in `pi/`, `app/`, `domain/`,
  `features/messages`, `features/editor`, `features/status-line` — those surfaces belong to
  `pi-zentui` in this setup.

## Open items / known gaps

1. **pi-style's message-boundary resets are not ported.** Their coordinator clears per-call registries
   on message boundaries; here they reset only on session start/shutdown. Long sessions with thousands
   of tool calls keep those maps alive until then. If memory ever matters, wire a message-boundary
   reset to `resetPistyleRegistries()`.
2. **`fff-multi-grep` uses the boxed fallback card.** Its args are `{ patterns: [...] }`, which no
   pi-style renderer parses. An adapter could synthesise a `pattern` string and route it to the grep
   renderer — deliberately not done (would be a hand-rolled invention again).
3. **pi-style's git/gh cards are only reachable through the `bash` renderer's command parsing.** The
   `git_*` tool family renders as fallback cards.
4. **Card sizing is source-only.** There is no config file any more; `TOOL_DISPLAY_CONFIG` in
   `src/index.ts` is the only knob, and changing it needs a `/reload`.

## Do not touch (owned elsewhere)

- `agent/zentui.json` — zentui owns the editor, footer, user messages and selector borders. The whole
  point of this fork is that pi-style's tool cards do not disturb it.
- `agent/themes/**`, `agent/settings.json` (packages/theme), `agent/npm/**` — not part of this
  extension's work.
- `agent/db-config.json`, `agent/auth.json`, `.env*`, `agent/models.json`, `agent/9router-config.json`
  — secrets/config; never read values into logs or docs.
- Other extensions' directories (`filechanges`, `bash-guard`, …) — the 4 `tsc` errors in
  `agent/extensions/skills-hint.ts` are a known, out-of-scope baseline.

## Reviewer checklist for a change here

1. Does the change stay inside the non-vendored files (`src/index.ts`, `src/wiring.ts`), or is it a
   documented fork delta in `FORK.md`?
2. Does it add any per-render I/O, allocation or timer? (It should not.)
3. Does it use only theme tokens that exist in pi's theme schema **and** `tokyo-night.json`?
4. Is every deliberate delta from upstream recorded in `FORK.md`?
5. Does it touch `src/pistyle/**` without a re-port reason? (Vendored code should stay pristine.)
