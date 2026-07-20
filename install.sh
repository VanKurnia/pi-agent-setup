#!/usr/bin/env bash
# Pi Coding Agent — installer / updater
# Run from anywhere: curl -fsSL ... | bash
# Or from repo root: ./install.sh [--update]

set -euo pipefail

# Abort if not running under bash (e.g. minimal containers with sh)
if [ -z "${BASH_VERSION:-}" ]; then
  echo "Error: install.sh requires bash" >&2
  exit 1
fi

PI_ROOT="${PI_ROOT:-$HOME/.pi}"
REPO_URL="${PI_REPO_URL:-https://github.com/VanKurnia/pi-agent-setup.git}"
BRANCH="${PI_BRANCH:-main}"
MODE="${1:-install}"

BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; NC="\033[0m"

say()  { echo -e "${BOLD}$*${NC}"; }
ok()   { echo -e "${GREEN}\xe2\x9c\x93${NC} $*"; }
warn() { echo -e "${YELLOW}\xe2\x9a\xa0${NC} $*"; }
err()  { echo -e "${RED}\xe2\x9c\x97${NC} $*"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "Missing dependency: $1"; exit 1; }
}

say "Pi Coding Agent - ${MODE^}"
say "Target: $PI_ROOT"

# Pre-flight
require_cmd git
require_cmd node
require_cmd npm

# ── Clone or update repo ──────────────────────────────────────
if [[ -d "$PI_ROOT/.git" ]]; then
  say "Updating existing repo..."

  # Warn and stash local changes before hard reset
  if ! git -C "$PI_ROOT" diff --quiet || ! git -C "$PI_ROOT" diff --cached --quiet; then
    warn "Local changes detected — stashing before update"
    git -C "$PI_ROOT" stash push -m "pre-install-$(date +%s)" --quiet
  fi

  git -C "$PI_ROOT" fetch origin "$BRANCH" --quiet
  git -C "$PI_ROOT" reset --hard "origin/$BRANCH" --quiet
else
  say "Cloning $REPO_URL ..."
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$PI_ROOT"
fi

# ── Migration: handle old extensions/ directory ───────────────
if [[ -d "$PI_ROOT/extensions" && ! -d "$PI_ROOT/agent/extensions" ]]; then
  if [[ -n "$(ls -A "$PI_ROOT/extensions" 2>/dev/null)" ]]; then
    say "Migrating extensions/ to agent/extensions/..."
    mkdir -p "$PI_ROOT/agent"
    mv "$PI_ROOT/extensions" "$PI_ROOT/agent/extensions"
    ok "Migration complete. Extensions now at agent/extensions/."
  else
    rmdir "$PI_ROOT/extensions" 2>/dev/null || true
  fi
elif [[ -d "$PI_ROOT/extensions" && -d "$PI_ROOT/agent/extensions" && -n "$(ls -A "$PI_ROOT/extensions" 2>/dev/null)" ]]; then
  warn "Both extensions/ and agent/extensions/ exist with content."
  warn "Files in extensions/ will NOT be moved automatically."
  warn "If you have custom extensions in extensions/, move them manually."
fi

# Install root deps
say "Installing root dependencies..."
npm -C "$PI_ROOT" install --prefer-offline --no-audit --no-fund --silent

# Install agent npm extensions
say "Installing agent npm extensions..."
npm -C "$PI_ROOT/agent/npm" install --prefer-offline --no-audit --no-fund --silent

# Build TypeScript extensions
say "Building TypeScript extensions..."
for ext_dir in "$PI_ROOT/agent/extensions"/*/; do
  [[ -f "$ext_dir/package.json" ]] || continue
  say "  Building $(basename "$ext_dir")..."
  (cd "$ext_dir" && npm install --prefer-offline --no-audit --no-fund --silent 2>/dev/null \
    && npx tsc --noEmit 2>/dev/null) || warn "Build failed for $(basename "$ext_dir") (non-fatal)"
done

# Ensure local config files exist
say "Checking local config..."

# .env
if [[ ! -f "$PI_ROOT/.env" && -f "$PI_ROOT/.env.example" ]]; then
  cp "$PI_ROOT/.env.example" "$PI_ROOT/.env"
  ok "Created .env from example - edit with your keys"
else
  ok ".env exists"
fi

# models.json
if [[ ! -f "$PI_ROOT/agent/models.json" && -f "$PI_ROOT/agent/models.example.json" ]]; then
  cp "$PI_ROOT/agent/models.example.json" "$PI_ROOT/agent/models.json"
  ok "Created agent/models.json from example"
else
  ok "agent/models.json exists"
fi

# 9router-config.json
if [[ ! -f "$PI_ROOT/agent/9router-config.json" ]]; then
  cat > "$PI_ROOT/agent/9router-config.json" <<'EOF'
{
  "baseUrl": "http://localhost:20128",
  "apiKey": "sk-9a0ed15031caf806-mu0zo9-aaf53a85",
  "enableReasoning": false
}
EOF
  ok "Created agent/9router-config.json (edit with your 9router URL/key)"
else
  ok "agent/9router-config.json exists"
fi

# auth.json
if [[ ! -f "$PI_ROOT/agent/auth.json" ]]; then
  echo '{}' > "$PI_ROOT/agent/auth.json"
  ok "Created agent/auth.json"
else
  ok "agent/auth.json exists"
fi

# settings.json
if [[ ! -f "$PI_ROOT/agent/settings.json" ]]; then
  # Bootstrap settings.json from agent/npm/package.json (single source of truth)
  NPM_PKG_JSON="$PI_ROOT/agent/npm/package.json"
  if [ -f "$NPM_PKG_JSON" ]; then
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      const deps = Object.keys(pkg.dependencies || {});
      const settings = {
        packages: deps.map(d => 'npm:' + d),
        theme: 'dark'
      };
      fs.writeFileSync(process.argv[2], JSON.stringify(settings, null, 2) + '\n');
    " "$NPM_PKG_JSON" "$PI_ROOT/agent/settings.json" 2>/dev/null || true
  fi
  if [ -f "$PI_ROOT/agent/settings.json" ]; then
    ok "Created agent/settings.json from agent/npm/package.json"
  else
    ok "agent/settings.json bootstrapped (no npm packages found — add deps manually)"
  fi
else
  ok "agent/settings.json exists"
fi

# zentui.json
if [[ ! -f "$PI_ROOT/agent/zentui.json" && -f "$PI_ROOT/zentui.json" ]]; then
  cp "$PI_ROOT/zentui.json" "$PI_ROOT/agent/zentui.json"
  ok "Copied zentui.json to agent/"
fi

# db-config.json
if [[ ! -f "$PI_ROOT/agent/db-config.json" && -f "$PI_ROOT/db-config.json" ]]; then
  cp "$PI_ROOT/db-config.json" "$PI_ROOT/agent/db-config.json"
  ok "Copied db-config.json to agent/"
fi

# pi-speeed post-install fix (HOME on Windows)
SPEEDD_SRC="$PI_ROOT/agent/npm/node_modules/pi-speeed/src"
if [[ -d "$SPEEDD_SRC" ]]; then
  node -e "
    const fs = require('fs');
    const path = require('path');
    const dir = process.argv[1];
    for (const file of ['config.ts', 'stats.ts']) {
      const fp = path.join(dir, file);
      if (!fs.existsSync(fp)) continue;
      let src = fs.readFileSync(fp, 'utf8');
      if (!src.includes('process.env.HOME')) continue;
      if (!src.includes('homedir')) {
        src = src.replace(
          /(import.*from ['\"]node:path['\"];?)/,
          '\$1\nimport { homedir } from \"node:os\";'
        );
      }
      src = src.replace(/process\.env\.HOME\s*\?\?\s*\"\"/g, 'homedir()');
      src = src.replace(/process\.env\.HOME\s*\|\|\s*\"\"/g, 'homedir()');
      fs.writeFileSync(fp, src);
    }
  " "$SPEEDD_SRC" 2>/dev/null && ok "Patched pi-speeed HOME resolution" || warn "pi-speeed patch failed (non-fatal)"
fi

# Health check
say "Health check..."
if command -v pi >/dev/null 2>&1 && pi --version >/dev/null 2>&1; then
  VERSION=$(pi --version 2>&1 | head -1)
  ok "Pi CLI works: $VERSION"
elif npx pi --version >/dev/null 2>&1; then
  VERSION=$(npx pi --version 2>&1 | head -1)
  ok "Pi CLI works via npx: $VERSION"
else
  warn "Pi binary not responding - run 'npx pi --help' to debug"
fi

# Summary
echo
say "Install complete!"
echo
echo "Next steps:"
echo "  1. Edit $PI_ROOT/.env with your API keys"
echo "  2. Edit $PI_ROOT/agent/9router-config.json if using remote 9router"
echo "  3. Start 9router (if local): 9router"
echo "  4. Run: pi"
echo
echo "Note: 'pi' runs via npx or global npm install. No PATH modification needed."