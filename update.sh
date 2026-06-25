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
NULL_DEV="/dev/null"

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

# ── Migration: handle old extensions/ directory ──────────────
if [ -d "$SCRIPT_DIR/extensions" ] && [ ! -d "$SCRIPT_DIR/agent/extensions" ]; then
  if [ -n "$(ls -A "$SCRIPT_DIR/extensions" 2>/dev/null)" ]; then
    echo "Migrating extensions/ to agent/extensions/..."
    mkdir -p "$SCRIPT_DIR/agent"
    # Move everything from old extensions/ to agent/extensions/
    mv "$SCRIPT_DIR/extensions" "$SCRIPT_DIR/agent/extensions"
    echo "Migration complete. Extensions now at agent/extensions/."
  else
    # Empty directory — just remove it
    rmdir "$SCRIPT_DIR/extensions" 2>/dev/null || true
  fi
elif [ -d "$SCRIPT_DIR/extensions" ] && [ -d "$SCRIPT_DIR/agent/extensions" ] && [ -n "$(ls -A "$SCRIPT_DIR/extensions" 2>/dev/null)" ]; then
  # Both exist — user may have local changes in old location
  echo "WARNING: Both extensions/ and agent/extensions/ exist."
  echo "Files in extensions/ will NOT be moved automatically."
  echo "If you have custom extensions in extensions/, please move them manually."
fi

# ── Clean existing packages list — rebuild from scratch ──
SETTINGS="$SCRIPT_DIR/agent/settings.json"
if [ -f "$SETTINGS" ]; then
  node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    s.packages = [];
    fs.writeFileSync(process.argv[1], JSON.stringify(s, null, 2) + '\n');
  " "$SETTINGS" 2>$NULL_DEV || true
fi

# Add npm pi packages (these are NOT auto-discovered)
npm_packages=(
  "npm:@ff-labs/pi-fff"
  "npm:pi-9router-ext"
  "npm:pi-x-ide"
  "npm:pi-zentui"
)
for pkg in "${npm_packages[@]}"; do
  node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const p = process.argv[2];
    if (!s.packages.includes(p)) { s.packages.push(p); fs.writeFileSync(process.argv[1], JSON.stringify(s, null, 2) + '\n'); }
  " "$SETTINGS" "$pkg" 2>$NULL_DEV || true
done

# ── Gather Packages & Standalone Extensions ──────────────
PKGS=()
while read -r pkg_path; do
  if [[ "$pkg_path" == *"package.json"* ]]; then
    PKGS+=("$(dirname "$pkg_path")")
  fi
done < <(find "$SCRIPT_DIR" \( -name "node_modules" -o -name ".git" -o -name "tmp" \) -prune -o -name "package.json" -print)

# Standalone .ts files in agent/extensions/ — auto-discovered by pi
# (pi scans ~/.pi/agent/extensions/*.ts and ~/.pi/agent/extensions/*/index.ts).
# No need to add them to settings.json packages.

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
for pkg in "${PKGS[@]}"; do
  update_ui
  if [[ "$pkg" == *.ts ]]; then
    # Standalone .ts extension — add to settings.json packages if missing
    rel_path="..\\extensions\\$(basename "$pkg")"
    if ! grep -q "\"$rel_path\"" "$SETTINGS" 2>$NULL_DEV; then
      node -e "
        const fs = require('fs');
        const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
        const p = process.argv[2];
        if (!s.packages.includes(p)) { s.packages.push(p); fs.writeFileSync(process.argv[1], JSON.stringify(s, null, 2) + '\n'); }
      " "$SETTINGS" "$rel_path" 2>$NULL_DEV || true
    fi
  else
    # Directory package
    pkg_json="$pkg/package.json"
    if [ -f "$pkg_json" ] && grep -q '"pi"' "$pkg_json" 2>$NULL_DEV; then
      # Has "pi" key → local pi extension (auto-discovered, no pi install needed)
      (cd "$pkg" && npm install) > $NULL_DEV 2>&1 || true
    elif [ -f "$pkg_json" ] && grep -q '"pi-extensions"' "$pkg_json" 2>$NULL_DEV; then
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
    elif [ -f "$pkg_json" ]; then
      # Standard npm package
      (cd "$pkg" && npm install) > $NULL_DEV 2>&1 || true
    fi
  fi

  CURRENT_STEP=$(( CURRENT_STEP + 1 ))
done

update_ui
echo -e "\n${GREEN}✅ Update complete!${NC}"
