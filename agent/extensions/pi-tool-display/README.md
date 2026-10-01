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

- `src/` — upstream 0.5.0 sources (compact tool rows; `bash-display.ts` and `diff-renderer.ts`
  verbatim).
- `src/pistyle/` — vendored `@quandev104/pi-style@0.2.11` boxed renderers and shared modules.
- `src/pistyle-bridge.ts` — maps this extension's config, theme, and Pi's renderer arguments onto
  the ported renderers.
- `src/pistyle-tool-patch.ts` — routes every tool through them by patching Pi's renderer resolution,
  so tools owned by other extensions are covered too.
- `FORK.md` — every intentional delta versus upstream.
- `docs/` — architecture, integration recipe, pitfalls, maintenance.
- `config.json` — live configuration, edited by `/tool-display`.

## Use

- `/tool-display` opens the settings modal. `boxedToolCalls` selects the pi-style cards (on) or the
  upstream compact rows (off); `collapseAfterTurn` applies to the boxed cards.
- `/reload` applies extension changes.

## Updating

- Upstream `pi-tool-display`: `npm pack pi-tool-display@<version>` and cherry-pick file-by-file.
- `pi-style`: re-run the port steps in `docs/INTEGRATION.md`, then re-apply the fork deltas listed in
  `FORK.md`.
