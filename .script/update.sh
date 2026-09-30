#!/usr/bin/env bash

# ──────────────────────────────────────────────────────────────
# pi-agent-setup — .script/update.sh
#   Fresh-clone updater for ~/.pi (or $1):
#     1. Stage ALL untracked files in the old checkout (user data —
#        including git-ignored managed files like .env/auth.json;
#        only */node_modules/* is skipped, rebuilt by npm-ci-all.sh)
#     2. `git clone --depth 1` the remote into a sibling temp dir —
#        the old checkout is untouched if the network fails
#     3. Rename-swap old aside / clone in (no merges, ever — a broken
#        upstream commit can never tangle local state; rename also
#        survives Windows file locks that recursive delete may not)
#     4. Copy staged user data back, sync settings packages,
#        `npm-ci-all.sh --install`, re-apply the post-install
#        patches (pi-speeed HOME, host-dependency declarations),
#        remove the old checkout last
#
#   Run from anywhere. `/update-setup` spawns it with cwd=$PI_DIR.
#   Limitations: empty directories cannot be preserved (git cannot
#   list them); unpushed local commits are lost — push first if the
#   pre-swap warning names any.
# ──────────────────────────────────────────────────────────────

set -euo pipefail

# Abort if not running under bash (e.g. minimal containers with sh)
if [ -z "${BASH_VERSION:-}" ]; then
  echo "Error: update.sh requires bash" >&2
  exit 1
fi

# The script replaces the checkout it lives in, so re-exec from a stable
# copy outside PI_DIR first (bash reads scripts incrementally — the swap
# below would otherwise delete the running file mid-run).
if [[ "${PI_UPDATE_INNER:-}" != "1" ]]; then
  STABLE="$(mktemp)"
  cp "$0" "$STABLE"
  export PI_UPDATE_INNER=1 STABLE_CLEANUP="$STABLE"
  exec bash "$STABLE" "$@"
fi
trap 'rm -f "${STABLE_CLEANUP:-}"' EXIT

BOLD='\033[1m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; NC='\033[0m'
say()  { echo -e "${BOLD}$*${NC}"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*"; }

command -v git >/dev/null 2>&1 || { err "Missing dependency: git"; exit 1; }
command -v node >/dev/null 2>&1 || { err "Missing dependency: node"; exit 1; }
command -v npm >/dev/null 2>&1 || { err "Missing dependency: npm"; exit 1; }

PI_DIR="${1:-$HOME/.pi}"
if [[ -d "$PI_DIR" ]]; then
  PI_DIR="$(cd "$PI_DIR" && pwd)" # normalize: later steps cd away and back
fi
REPO_URL="${PI_REPO_URL:-https://github.com/VanKurnia/pi-agent-setup.git}"
BRANCH="${PI_BRANCH:-main}"
NEW="${PI_DIR}.new.$$"
BAK="${PI_DIR}.bak.$$"

# Stale temps from a crashed run (different PID — current-PID names can't match them)
for stale in "${PI_DIR}".new.* "${PI_DIR}".bak.*; do
  [[ -e "$stale" ]] || continue
  warn "Removing stale temp from a previous run: $stale"
  rm -rf "$stale" || true
done

# ── 1. Stage ALL untracked files (user data) out of the old checkout ──
# NOTE: no --exclude-standard — git-ignored managed files (.env,
# auth.json, subagents.json, sessions/) are user data and must survive.
# Only node_modules is skipped (rebuilt by npm-ci-all.sh): excluded at the
# git level so dep trees are neither walked per-file nor counted; the loop
# guard below stays as fallback.
PRESERVE="$(mktemp -d)"
trap 'rm -f "${STABLE_CLEANUP:-}"; [[ -d "${PRESERVE:-}" ]] && echo "Staged user data kept at: $PRESERVE"' EXIT
if [[ -d "$PI_DIR/.git" ]]; then
  UNPUSHED="$(git -C "$PI_DIR" log "origin/$BRANCH..HEAD" --oneline 2>/dev/null | head -n 5)"
  if [[ -n "$UNPUSHED" ]]; then
    warn "Unpushed local commits will be LOST by the fresh clone — push first if they matter:"
    echo "$UNPUSHED" | sed 's/^/    /'
  fi
  say "Staging untracked user data..."
  while IFS= read -r -d '' f; do
    # Root node_modules/ has no leading slash segment, so it needs its own arm.
    [[ "$f" == node_modules/* || "$f" == */node_modules/* ]] && continue
    mkdir -p "$PRESERVE/$(dirname "$f")"
    cp -a "$PI_DIR/$f" "$PRESERVE/$f"
  done < <(git -C "$PI_DIR" ls-files --others -z --exclude='node_modules')
  COUNT="$(git -C "$PI_DIR" ls-files --others -z --exclude='node_modules' | tr -dc '\0' | wc -c)"
  ok "$COUNT untracked path(s) staged (excluding node_modules)"
elif [[ -e "$PI_DIR" && -n "$(ls -A "$PI_DIR" 2>/dev/null)" ]]; then
  err "$PI_DIR exists but is not a git checkout — refusing to replace it."
  err "Back it up or point PI_DIR at your checkout, then re-run."
  exit 1
fi

# ── 2. Clone first — the old checkout is untouched if this fails ──
say "Cloning $REPO_URL ($BRANCH) ..."
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$NEW"
git -C "$NEW" config core.hooksPath .husky
ok "Fresh clone ready"

# ── 3. Rename-swap (robust against locked files) ──
cd "$HOME" # leave PI_DIR so no cwd handle pins it
if [[ -e "$PI_DIR" ]]; then
  mv "$PI_DIR" "$BAK"
fi
mv "$NEW" "$PI_DIR"
ok "Checkout swapped in"

# ── 4. Copy user data back ──
if [[ -n "$(ls -A "$PRESERVE" 2>/dev/null)" ]]; then
  cp -a "$PRESERVE/." "$PI_DIR/"
  ok "User data restored (user files win over upstream on same-path conflicts)"
fi
rm -rf "$PRESERVE"

# ── 5. Sync settings.json packages from agent/npm/package.json ──
SETTINGS="$PI_DIR/agent/settings.json"
NPM_PKG_JSON="$PI_DIR/agent/npm/package.json"
if [[ -f "$NPM_PKG_JSON" && -f "$SETTINGS" ]]; then
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const s = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    s.packages = Object.keys(pkg.dependencies || {}).map(d => 'npm:' + d);
    fs.writeFileSync(process.argv[2], JSON.stringify(s, null, 2) + '\n');
  " "$NPM_PKG_JSON" "$SETTINGS" \
    && ok "settings.json packages synced" \
    || warn "settings.json sync failed (non-fatal — fix packages[] manually)"
fi

# ── 6. Install all deps (npm ci where locked, npm install elsewhere) ──
if [[ -f "$PI_DIR/.script/npm-ci-all.sh" ]]; then
  bash "$PI_DIR/.script/npm-ci-all.sh" --install
  ok "Dependencies installed"
else
  err "$PI_DIR/.script/npm-ci-all.sh missing — broken clone, aborting"
  exit 1
fi

# ── 7. Re-apply post-install patches (npm ci reinstalls deps pristine) ──
if [[ -f "$PI_DIR/.script/patch-speeed-home.sh" ]]; then
  bash "$PI_DIR/.script/patch-speeed-home.sh" "$PI_DIR"
else
  warn ".script/patch-speeed-home.sh missing in fresh clone (skipped)"
fi
if [[ -f "$PI_DIR/.script/patch-host-deps.sh" ]]; then
  bash "$PI_DIR/.script/patch-host-deps.sh" "$PI_DIR"
else
  warn ".script/patch-host-deps.sh missing in fresh clone (skipped)"
fi

# ── 8. Old checkout removal LAST — every destructive step now precedes it ──
# Best-effort: may fail on Windows-locked node_modules — non-fatal.
if [[ -e "$BAK" ]]; then
  rm -rf "$BAK" 2>/dev/null && ok "Old checkout removed" \
    || warn "Could not remove backup $BAK (locked files?) — delete it manually when pi is closed"
fi

echo -e "\n${GREEN}✅ Update complete!${NC}"

if [[ ! -f "$PI_DIR/.env" && -f "$PI_DIR/.env.example" ]]; then
  echo ""
  warn "No .env found — copy .env.example to .env and edit it"
  warn "  cp .env.example .env"
fi
