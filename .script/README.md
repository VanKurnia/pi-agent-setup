# `.script/` — helper scripts for `~/.pi`

Small bash utilities for maintaining this repo (`~/.pi`, the pi-agent-setup checkout).
Run them from the repo root. All scripts require `bash` + `npm` on `PATH`
(Git Bash on Windows is fine).

| Script | Purpose |
| --- | --- |
| [`npm-ci-all.sh`](#npm-ci-allsh) | Recursively run `npm ci` in every project dir |
| [`update.sh`](#updatesh) | Fresh-clone updater for the workspace (used by `/update-setup`) |
| [`patch-speeed-home.sh`](#patch-speeed-homesh) | Re-apply pi-speeed Windows HOME fix (used by `install.sh`, `update.sh`) |
| [`patch-host-deps.sh`](#patch-host-depssh) | Move host-provided packages from `dependencies` to `peerDependencies` in installed extensions (used by `install.sh`, `update.sh`) |
| [`bench-om.mjs`](#bench-ommjs) | Benchmark Blackhole Observational Memory token compression & prompt cache stability |

---

## `npm-ci-all.sh`

Installs dependencies for every Node project under the repo in one go.

A "project dir" is any directory containing `package.json`, **excluding**
`node_modules/`, `.git/`, and `tmp/` trees (so nested dependency manifests
and transient `tmp/extensions/npm/...` unpack dirs are skipped).

- Dirs **with** `package-lock.json` → `npm ci` (clean, reproducible install)
- Dirs with **only** `package.json` → skipped with a warning
  (`npm ci` requires a lockfile), unless `--install` is passed

### Usage

```bash
.script/npm-ci-all.sh [--install] [--dry-run] [--fail-fast]
.script/npm-ci-all.sh --help
```

| Flag | Effect |
| --- | --- |
| `--install` | Fall back to `npm install` in dirs without a lockfile |
| `--dry-run` | List what would run without running anything |
| `--fail-fast` | Abort on the first failure (default: keep going, then summarize) |
| `--skip-disabled` | Skip dirs whose extension entry (`pi.extensions[0]`, else `main`) exists on disk only as `<entry>.disabled` (opt-in; default: install everything; root `.`, `agent/npm`, `pi-speeed` have no entry and never skip) |
| (always on) `--no-audit --no-fund` | Passed to every `npm ci` / `npm install`; audit/fund output off (check vulnerabilities manually with `npm audit`) |
| `-h`, `--help` | Print usage |

### Examples

```bash
# Normal run: npm ci everywhere a lockfile exists
.script/npm-ci-all.sh

# Preview first (no changes)
.script/npm-ci-all.sh --dry-run

# Also cover lockless dirs (browser-tools, db-viewer, pi-cbm, pi-speeed)
.script/npm-ci-all.sh --install

# Stop at the first broken install
.script/npm-ci-all.sh --fail-fast

# Skip disabled-entry extensions (preview; also works on real runs)
.script/npm-ci-all.sh --dry-run --skip-disabled

# Audit/fund output is always off; check vulnerabilities manually
npm audit
```

### Exit codes / output

- Prints a per-dir header (`=== [<dir>]: <cmd> ===`), then a summary line:
  `Summary: N ok, M failed, K skipped (of T manifests)`.
- Exit `0` when nothing failed (skips don't fail the run);
  exit `1` and a failed-dir list otherwise.

### Notes

- Currently covers 10 manifests, all with committed lockfiles
  (reproducible `npm ci` installs). Keep it that way: when adding a
  dependency, commit the resulting `package-lock.json`.
Interim (2026-09-24): agent/npm/.npmrc sets legacy-peer-deps=true because pi-tool-display@0.5.0 peers cap at pi ^0.80.0. Remove this note with the file per .plans/049-bump-pi-tool-display-for-pi-087.md Step 5.
- Re-run after pulling, switching branches, or (un)disabling an extension.

---

## `update.sh`

Fresh-clone updater for the workspace. Invoked by `/update-setup`
(`agent/extensions/update-setup.ts`), runnable by hand too:

```bash
.script/update.sh [PI_DIR]   # default: $HOME/.pi
```

Honors `PI_REPO_URL` / `PI_BRANCH` (defaults: GitHub `main`).

Flow: stage everything git-untracked aside → `git clone --depth 1` into a
sibling temp dir (old checkout untouched if the network fails) →
rename-swap old aside / clone in → copy user data back → sync
`settings.json:packages[]` from `agent/npm/package.json` →
`npm-ci-all.sh --install` → re-apply the pi-speeed `HOME` patch →
warn if `.env` is missing. Stale `.bak.$$` backup removal is best-effort
(Windows file locks) — delete manually when pi is closed if warned.

Git-ignored paths (`node_modules/`, `.plans/`) are NOT carried over —
`node_modules` is rebuilt; commit/push anything else you care about first.
Refuses to wipe a non-empty target that isn't a git checkout.

---

## `patch-speeed-home.sh`

Re-applies the pi-speeed `process.env.HOME` → `os.homedir()` fix.
`npm ci` reinstalls pi-speeed pristine, so both `install.sh` and
`update.sh` call this after installing dependencies:

```bash
.script/patch-speeed-home.sh [PI_ROOT]   # default: $HOME/.pi
```

Non-fatal by contract: always exits 0, prints `✓`/`⚠` itself.

---

## `patch-host-deps.sh`

Silences pi's startup warning about extension packages that declare
host-provided packages in `dependencies`:

```
Host-provided extension packages must be declared in peerDependencies with a "*"
range, not dependencies: @earendil-works/pi-tui, @sinclair/typebox.
```

pi injects its own copies of those packages as virtual modules
(`HOST_PROVIDED_EXTENSION_PACKAGES` in the host's `resource-loader.js`), so an
installed copy can only cause duplicate runtime modules. Some published
extensions still declare them the wrong way — `pi-smart-fetch@0.3.17` was the
offender (it has since been replaced by the local `smart-web-access`
extension), and `npm ci` restores any pristine manifest, so the rewrite runs
after every install:

```bash
.script/patch-host-deps.sh [PI_ROOT]   # default: $HOME/.pi
```

Scans `$PI_ROOT/agent/npm/node_modules` (top-level and `@scope/*` packages) and,
per offending manifest, deletes the host package from `dependencies`, adds it to
`peerDependencies` as `"*"`, and rewrites the file as 2-space JSON. Idempotent.

`node_modules` copies of those packages are left on disk on purpose: npm
reinstalls them from unchanged registry metadata anyway, and every such specifier
resolves to the host's bundles, so the copies are inert.

Non-fatal by contract: always exits 0, prints `✓`/`⚠` itself.

---

## `bench-om.mjs`

Effectiveness benchmark and verification harness for Blackhole's Observational Memory (OM) engine. Replays real session history or synthetic workloads against Mastra AI Observational Memory research standards.

Evaluates:
- **Token Compression Ratio**: Raw tokens vs compacted observations + reflections.
- **Prompt Cache Stability**: Percentage of turns where the observation prefix is 100% stable/cacheable.
- **Cadence & Threshold Gating**: Measures trigger frequencies for Observer, Reflector, and Dropper.

### Usage

```bash
# Auto-detect and benchmark the largest real session file
node .script/bench-om.mjs

# Benchmark a specific session file
node .script/bench-om.mjs --session agent/sessions/.../session.jsonl

# Run a synthetic multi-turn coding workload
node .script/bench-om.mjs --synthetic 200

# Override token cadence thresholds
node .script/bench-om.mjs --observe-tokens 20000 --reflect-tokens 60000
```

