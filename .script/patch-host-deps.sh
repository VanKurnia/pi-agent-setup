#!/usr/bin/env bash

# ──────────────────────────────────────────────────────────────
# .script/patch-host-deps.sh — keep installed extension packages loadable
#
#   pi warns at startup for every extension package that declares a
#   host-provided package in `dependencies` instead of in
#   `peerDependencies` with a "*" range (the host injects those
#   modules itself, so installed copies only risk duplicate runtimes).
#   Source of truth: HOST_PROVIDED_EXTENSION_PACKAGES in
#   pi-coding-agent dist/core/resource-loader.js; the host satisfies
#   those specifiers through dist/core/extensions/virtual-modules.js.
#
#   Some published extensions still ship the wrong declaration —
#   e.g. pi-smart-fetch@0.3.17 listed @earendil-works/pi-tui and
#   @sinclair/typebox as dependencies (no longer installed here: the local
#   smart-web-access extension supersedes it, and other packages may repeat
#   the mistake). Upstream was unfixed at that version, and `npm ci` restores
#   the pristine manifest, so this rewrite must run after every dependency
#   install.
#
#   Installed copies of those packages are deliberately left on disk:
#   npm reinstalls them from the unchanged registry metadata anyway,
#   and the host resolves everyone of those specifiers to its own
#   bundled modules, so the copies are inert.
#
#   Non-fatal by contract: always exits 0. Prints ok/warn itself.
#   Called by install.sh and .script/update.sh after (re)installing
#   dependencies. Idempotent — a second run finds nothing to move.
#
#   Usage: .script/patch-host-deps.sh [PI_ROOT]   (default: $HOME/.pi)
# ──────────────────────────────────────────────────────────────

set -euo pipefail

GREEN='\033[32m'; YELLOW='\033[33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }

PI_ROOT="${1:-$HOME/.pi}"
MODULES="$PI_ROOT/agent/npm/node_modules"
[[ -d "$MODULES" ]] || exit 0

# Prints one line per patched package ("<name>: <moved>, <moved>"), or
# nothing when every manifest already declares host packages as peers.
if OUTPUT="$(node -e '
  const fs = require("fs");
  const path = require("path");

  // Mirror of HOST_PROVIDED_EXTENSION_PACKAGES — keep in sync when pi adds entries.
  const HOST_PACKAGES = new Set([
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "@mariozechner/pi-agent-core",
    "@mariozechner/pi-ai",
    "@mariozechner/pi-coding-agent",
    "@mariozechner/pi-tui",
    "@sinclair/typebox",
    "typebox",
  ]);

  const modulesDir = process.argv[1];
  const manifests = [];
  for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      const scopeDir = path.join(modulesDir, entry.name);
      for (const scoped of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (scoped.isDirectory()) manifests.push(path.join(scopeDir, scoped.name, "package.json"));
      }
      continue;
    }
    manifests.push(path.join(modulesDir, entry.name, "package.json"));
  }

  for (const manifestPath of manifests) {
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      continue; // malformed manifest is pi/eslint territory, not ours
    }
    const dependencies = manifest.dependencies;
    if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) continue;
    const offenders = Object.keys(dependencies).filter((name) => HOST_PACKAGES.has(name));
    if (offenders.length === 0) continue;

    for (const name of offenders) {
      delete dependencies[name];
      manifest.peerDependencies = manifest.peerDependencies ?? {};
      manifest.peerDependencies[name] = "*";
    }
    // Sorted peer block keeps the rewrite deterministic (and matches the
    // convention every healthy extension in this tree already follows).
    manifest.peerDependencies = Object.fromEntries(
      Object.entries(manifest.peerDependencies).sort(([a], [b]) => a.localeCompare(b)),
    );
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`${manifest.name ?? path.basename(path.dirname(manifestPath))}: ${offenders.sort().join(", ")}`);
  }
' "$MODULES" 2>/dev/null)"; then
  if [[ -n "$OUTPUT" ]]; then
    while IFS= read -r line; do
      ok "peerDependencies: $line"
    done <<< "$OUTPUT"
    ok "Patched host-provided dependency declarations"
  else
    ok "Extension manifests already declare host packages as peers"
  fi
else
  warn "Host-dependency patch failed (non-fatal)"
fi

exit 0
