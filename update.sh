#!/usr/bin/env bash

# ──────────────────────────────────────────────────────────────
# pi-agent-setup — update.sh
#   • Detects the user's .pi directory ($HOME/.pi, or $1)
#   • If running from elsewhere, moves/copies all files there
#     (overwriting any conflicts)
#   • Then installs extensions and npm dependencies
# ──────────────────────────────────────────────────────────────

set -euo pipefail

# Abort if not running under bash (e.g. minimal containers with sh)
if [ -z "${BASH_VERSION:-}" ]; then
  echo "Error: update.sh requires bash" >&2
  exit 1
fi

# Cross-platform null device
case "$(uname -s)" in
  Linux*|Darwin*) NULL_DEV="/dev/null" ;;
  CYGWIN*|MINGW*|MSYS*) NULL_DEV="nul" ;;
  *) NULL_DEV="/dev/null" ;;
esac

# tput cursor-up helper (no-op on non-ANSI terminals)
if command -v tput &> $NULL_DEV && [ -t 1 ]; then
  CURSOR_UP="$(tput cuu 2> $NULL_DEV || echo '')"
else
  CURSOR_UP=""
fi

# ── Resolve paths ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="${1:-$HOME/.pi}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

# ──────────────────────────────────────────────────────────────
#  INIT — copy/move files to the user's .pi directory
# ──────────────────────────────────────────────────────────────
if [[ "$SCRIPT_DIR" != "$PI_DIR" ]]; then
  echo -e "${BOLD}📦 Initializing pi at ${PI_DIR}${NC}"
  echo -e "${YELLOW}   (source: $SCRIPT_DIR)${NC}\n"

  mkdir -p "$PI_DIR"

  # Move everything over, overwriting conflicts.
  # rm target item first so mv doesn't nest dirs into existing dirs.
  shopt -s dotglob
  for item in "$SCRIPT_DIR"/*; do
    baseitem=$(basename "$item")
    [[ "$baseitem" == "." || "$baseitem" == ".." ]] && continue

    # Never overwrite target .git — target repo owns its history
    [[ "$baseitem" == ".git" ]] && continue

    rm -rf "$PI_DIR/$baseitem" 2> $NULL_DEV || true
    mv -f "$item" "$PI_DIR/" 2> $NULL_DEV || cp -rf "$item" "$PI_DIR/"
  done
  shopt -u dotglob

  # Switch to target dir and recalculate paths in-process
  cd "$PI_DIR"
  SCRIPT_DIR="$PI_DIR"
  echo -e "\n${GREEN}✅ Files deployed to ${PI_DIR}${NC}"
  echo ""
fi

# ──────────────────────────────────────────────────────────────
#  WORKSPACE UPDATE (running from ~/.pi)
# ──────────────────────────────────────────────────────────────

# ── Gather Packages ──────────────────────────────────────
PKGS=()
while read -r pkg_path; do
  if [[ "$pkg_path" == *"package.json"* ]]; then
    PKGS+=("$(dirname "$pkg_path")")
  fi
done < <(find "$SCRIPT_DIR" \( -name "node_modules" -o -name ".git" -o -name "tmp" \) -prune -o -name "package.json" -print)

TOTAL_STEPS=${#PKGS[@]}
CURRENT_STEP=0

# ── UI helpers ────────────────────────────────────────────────
update_ui() {
    local lines_to_move=$((TOTAL_STEPS > 0 ? TOTAL_STEPS + 2 : 2))
    [ -n "$CURSOR_UP" ] && tput cuu "$lines_to_move" 2>/dev/null || true

    echo -e "${BOLD}Updating workspace components...${NC}"

    # Packages checklist
    for i in "${!PKGS[@]}"; do
        local pkg_dir="${PKGS[$i]}"
        local pkg_name=$(basename "$pkg_dir")
        local check="[ ]"
        if [[ $CURRENT_STEP -gt $i ]]; then
            check="${GREEN}[✓]${NC}"
        elif [[ $CURRENT_STEP -eq $i ]]; then
            check="${YELLOW}[...]${NC}"
        fi
        echo -e "$check $pkg_name"
    done

    # Progress bar
    local percent=$(( TOTAL_STEPS > 0 ? CURRENT_STEP * 100 / TOTAL_STEPS : 100 ))
    local filled=$(( percent / 5 ))
    local empty=$(( 20 - filled ))
    local bar=$(printf "%${filled}s" | tr ' ' '#')
    local spaces=$(printf "%${empty}s" | tr ' ' '-')

    echo -e "Progress: [${GREEN}${bar}${NC}${spaces}] $percent%"
}

# ── Initial UI ────────────────────────────────────────────────
echo -e "${BOLD}Updating workspace components...${NC}"
if [ $TOTAL_STEPS -gt 0 ]; then
  for pkg_dir in "${PKGS[@]}"; do echo "[ ] $(basename "$pkg_dir")"; done
fi
echo "Progress: [--------------------] 0%"

# ── Install Dependencies & Extensions ─────────────────────────
for pkg_dir in "${PKGS[@]}"; do
  update_ui
  pkg_json="$pkg_dir/package.json"

  if grep -q '"pi"' "$pkg_json" 2>$NULL_DEV; then
    # Has "pi" key → local pi extension
    pi install "$pkg_dir" > $NULL_DEV 2>&1 || true

  elif grep -q '"pi-extensions"' "$pkg_json" 2>$NULL_DEV; then
    # agent/npm style manifest → install each dep as npm pi extension
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      const deps = pkg.dependencies || {};
      for (const dep of Object.keys(deps)) {
        console.log(dep);
      }
    " "$pkg_json" 2>$NULL_DEV | while IFS= read -r dep; do
      pi install "npm:$dep" > $NULL_DEV 2>&1 || true
    done

  else
    # Standard npm package
    (cd "$pkg_dir" && npm install) > $NULL_DEV 2>&1 || true
  fi

  CURRENT_STEP=$(( CURRENT_STEP + 1 ))
done

update_ui
echo -e "\n${GREEN}✅ Update complete!${NC}"
