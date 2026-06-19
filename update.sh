#!/bin/bash

# ──────────────────────────────────────────────────────────────
# pi-agent-setup — update.sh
#   • Detects the user's .pi directory ($HOME/.pi, or $1)
#   • If running from elsewhere, moves/copies all files there
#     (overwriting any conflicts)
#   • Then installs extensions and npm dependencies
# ──────────────────────────────────────────────────────────────

set -e

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

  # Copy dotfiles & everything over (overwrite on conflict)
  shopt -s dotglob
  for item in "$SCRIPT_DIR"/*; do
    baseitem=$(basename "$item")
    [[ "$baseitem" == "." || "$baseitem" == ".." ]] && continue

    # Keep .git as copy (preserve any git history in the clone)
    if [[ "$baseitem" == ".git" ]]; then
      cp -rf "$item" "$PI_DIR/" 2>/dev/null || true
    else
      mv -f "$item" "$PI_DIR/" 2>/dev/null || cp -rf "$item" "$PI_DIR/"
    fi
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

EXT_DIR="$SCRIPT_DIR/extensions"

# ── Gather lists ──────────────────────────────────────────────
EXTENSIONS=()
shopt -s nullglob
for path in "$EXT_DIR"/*; do
  filename=$(basename "$path")
  [[ "$filename" == .* ]] && continue
  [[ "$filename" == "node_modules" ]] && continue
  EXTENSIONS+=("$filename")
done
shopt -u nullglob

PKGS=()
while read -r pkg_path; do
  if [[ "$pkg_path" == *"package.json"* ]]; then
    PKGS+=("$(dirname "$pkg_path")")
  fi
done < <(find "$SCRIPT_DIR" -name "node_modules" -prune -o -name "package.json" -print)

TOTAL_STEPS=$((${#EXTENSIONS[@]} + ${#PKGS[@]}))
CURRENT_STEP=0

# ── UI helpers ────────────────────────────────────────────────
update_ui() {
    local lines_to_move=$((TOTAL_STEPS + 2))
    tput cuu $lines_to_move 2>/dev/null || true

    echo -e "${BOLD}Updating workspace components...${NC}"

    # Extensions checklist
    for i in "${!EXTENSIONS[@]}"; do
        local ext="${EXTENSIONS[$i]}"
        local check="[ ]"
        if [[ $CURRENT_STEP -gt $i ]]; then
            check="${GREEN}[✓]${NC}"
        elif [[ $CURRENT_STEP -eq $i ]]; then
            check="${YELLOW}[...]${NC}"
        fi
        echo -e "$check $ext"
    done

    # Packages checklist
    for i in "${!PKGS[@]}"; do
        local pkg="${PKGS[$i]}"
        local check="[ ]"
        local idx=$(( ${#EXTENSIONS[@]} + i ))
        if [[ $CURRENT_STEP -gt $idx ]]; then
            check="${GREEN}[✓]${NC}"
        elif [[ $CURRENT_STEP -eq $idx ]]; then
            check="${YELLOW}[...]${NC}"
        fi
        echo -e "$check $(basename "$pkg")"
    done

    # Progress bar
    local percent=$(( CURRENT_STEP * 100 / TOTAL_STEPS ))
    local filled=$(( percent / 5 ))
    local empty=$(( 20 - filled ))
    local bar=$(printf "%${filled}s" | tr ' ' '#')
    local spaces=$(printf "%${empty}s" | tr ' ' '-')

    echo -e "Progress: [${GREEN}${bar}${NC}${spaces}] $percent%"
}

# ── Initial UI ────────────────────────────────────────────────
echo -e "${BOLD}Updating workspace components...${NC}"
for ext in "${EXTENSIONS[@]}"; do echo "[ ] $ext"; done
for pkg in "${PKGS[@]}"; do echo "[ ] $(basename "$pkg")"; done
echo "Progress: [--------------------] 0%"

# ── Install extensions ──────────────────────────────────────
for path in "$EXT_DIR"/*; do
  filename=$(basename "$path")
  [[ "$filename" == .* ]] && continue
  [[ "$filename" == "node_modules" ]] && continue

  update_ui
  pi install "$path" > /dev/null 2>&1
  ((CURRENT_STEP++))
done

# ── NPM install ──────────────────────────────────────────────
for pkg_dir in "${PKGS[@]}"; do
  update_ui
  (cd "$pkg_dir" && npm install) > /dev/null 2>&1
  ((CURRENT_STEP++))
done

update_ui
echo -e "\n${GREEN}✅ Update complete!${NC}"
