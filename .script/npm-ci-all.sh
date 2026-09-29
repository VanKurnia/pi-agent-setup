#!/usr/bin/env bash
# Recursively run `npm ci` in every project dir under ~/.pi.
#
# A "project dir" is any dir containing package.json, excluding
# node_modules, .git and tmp trees. Dirs with package-lock.json get
# `npm ci`; dirs with only package.json are skipped (npm ci requires
# a lockfile) unless --install is given, in which case they get
# `npm install`.
#
# Usage:
#   .script/npm-ci-all.sh [--install] [--dry-run] [--fail-fast] [--skip-disabled]
#
#   --install    fall back to `npm install` where no lockfile exists
#   --dry-run    list what would run without running anything
#   --fail-fast  abort on first failure (default: continue, summarize)
#   --skip-disabled  skip dirs whose extension entry (`pi.extensions[0]`,
#                else `main`) exists on disk only as `<entry>.disabled`
#                (opt-in; default: install everything).
#                Every npm invocation carries `--no-audit --no-fund`
#                (audit/fund change nothing on disk; check vulns manually
#                with `npm audit`).

set -euo pipefail

if [ -z "${BASH_VERSION:-}" ]; then
  echo "Error: npm-ci-all.sh requires bash" >&2
  exit 1
fi

BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; NC="\033[0m"
say()  { echo -e "${BOLD}$*${NC}"; }
ok()   { echo -e "${GREEN}\xe2\x9c\x93${NC} $*"; }
warn() { echo -e "${YELLOW}\xe2\x9a\xa0${NC} $*"; }
err()  { echo -e "${RED}\xe2\x9c\x97${NC} $*"; }

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
}

# True iff $1 (a manifest dir, relative to repo root) declares an extension
# entry (`pi.extensions[0]`, else `main`) that exists on disk ONLY as
# `<entry>.disabled`. Dirs with no entry field at all (root `.`,
# `agent/npm`, `pi-speeed`) never skip. A leading `./` on the entry is
# normalized before joining.
is_disabled_entry() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    const dir = process.argv[1];
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      process.exit(1);
    }
    const exts = manifest.pi && manifest.pi.extensions;
    let entry = Array.isArray(exts) && exts.length > 0 ? exts[0] : manifest.main;
    if (!entry) process.exit(1);
    entry = String(entry).replace(/^\.\//, "");
    const live = path.join(dir, entry);
    if (fs.existsSync(live)) process.exit(1);
    process.exit(fs.existsSync(live + ".disabled") ? 0 : 1);
  ' "$1"
}

INSTALL_FALLBACK=0
DRY_RUN=0
FAIL_FAST=0
SKIP_DISABLED=0
for arg in "$@"; do
  case "$arg" in
    --install)   INSTALL_FALLBACK=1 ;;
    --dry-run)   DRY_RUN=1 ;;
    --fail-fast) FAIL_FAST=1 ;;
    --skip-disabled) SKIP_DISABLED=1 ;;
    -h|--help)   usage; exit 0 ;;
    *) err "Unknown argument: $arg"; usage >&2; exit 1 ;;
  esac
done

command -v npm >/dev/null 2>&1 || { err "Missing dependency: npm"; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

mapfile -t MANIFESTS < <(find . \
  \( -path './node_modules' -o -path './.git' -o -path './tmp' \
     -o -path './agent/tmp' -o -path '*/node_modules' \) -prune \
  -o -name 'package.json' -print | sort)

if [ "${#MANIFESTS[@]}" -eq 0 ]; then
  warn "No package.json found under $ROOT"
  exit 0
fi

OK=()
FAILED=()
SKIPPED=()

for manifest in "${MANIFESTS[@]}"; do
  dir="$(dirname "$manifest")"
  if [ "$SKIP_DISABLED" -eq 1 ] && is_disabled_entry "$dir"; then
    if [ "$DRY_RUN" -eq 1 ]; then
      say "WOULD SKIP $dir (disabled entry)"
    else
      warn "SKIP $dir (disabled entry)"
      SKIPPED+=("$dir (disabled entry)")
    fi
    continue
  fi
  if [ -f "$dir/package-lock.json" ]; then
    cmd="npm ci --no-audit --no-fund"
  elif [ "$INSTALL_FALLBACK" -eq 1 ]; then
    cmd="npm install --no-audit --no-fund"
  else
    warn "SKIP $dir (no package-lock.json; re-run with --install to npm install it)"
    SKIPPED+=("$dir (no lockfile)")
    continue
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    say "WOULD RUN [$dir]: $cmd"
    continue
  fi

  say "=== [$dir]: $cmd ==="
  if (cd "$dir" && npm ${cmd#npm }); then
    ok "$dir"
    OK+=("$dir")
  else
    err "$dir"
    FAILED+=("$dir")
    if [ "$FAIL_FAST" -eq 1 ]; then
      err "Aborting (--fail-fast)"
      exit 1
    fi
  fi
done

echo
say "Summary: ${#OK[@]} ok, ${#FAILED[@]} failed, ${#SKIPPED[@]} skipped (of ${#MANIFESTS[@]} manifests)"
if [ "${#FAILED[@]}" -gt 0 ]; then
  err "Failed dirs:"; printf '  - %s\n' "${FAILED[@]}"
  exit 1
fi
if [ "${#SKIPPED[@]}" -gt 0 ]; then
  warn "Skipped dirs:"; printf '  - %s\n' "${SKIPPED[@]}"
fi
