#!/usr/bin/env bash

# ──────────────────────────────────────────────────────────────
# .script/patch-speeed-home.sh — fix pi-speeed HOME resolution bug
#   pi-speeed uses process.env.HOME which is often unset on Windows,
#   causing ENOENT when it resolves paths relative to CWD instead of ~.
#   Rewrites the fallbacks to os.homedir(), which always works.
#
#   Non-fatal by contract: always exits 0. Prints ok/warn itself.
#   Called by install.sh and .script/update.sh after (re)installing
#   dependencies (npm ci reinstalls pi-speeed pristine, so the patch
#   must run after every install, not just once).
#
#   Usage: .script/patch-speeed-home.sh [PI_ROOT]  (default: $HOME/.pi)
# ──────────────────────────────────────────────────────────────

set -euo pipefail

GREEN='\033[32m'; YELLOW='\033[33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }

PI_ROOT="${1:-$HOME/.pi}"
SPEEDD_SRC="$PI_ROOT/agent/npm/node_modules/pi-speeed/src"
[[ -d "$SPEEDD_SRC" ]] || exit 0

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
