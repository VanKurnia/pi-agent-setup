#!/bin/bash

# Dynamically resolve the extension directory path relative to the script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$SCRIPT_DIR/extensions"

# Warn if not in a directory named .pi
if [[ "$(basename "$SCRIPT_DIR")" != ".pi" ]]; then
  echo "⚠️  Warning: This repository should typically be installed as '~/.pi' to be loaded by the 'pi' agent."
  echo "Current directory: $SCRIPT_DIR"
  echo ""
  echo "To set it up correctly, you can move it:"
  echo "  mv \"$SCRIPT_DIR\" ~/.pi"
  echo "  cd ~/.pi && bash update.sh"
  echo ""
fi

echo "Re-registering top-level extensions from $EXT_DIR..."

# Iterate over all files and folders immediately inside the extension directory
# using nullglob to gracefully handle an empty directory.
shopt -s nullglob
for path in "$EXT_DIR"/*; do
  # Ignore files or directories that start with a dot
  filename=$(basename "$path")
  if [[ "$filename" == .* ]]; then
    continue
  fi

  # Skip typical ignore paths if any exist (e.g. node_modules)
  if [[ "$filename" == "node_modules" ]]; then
    continue
  fi

  echo "Installing: $path"
  pi install "$path"
done
shopt -u nullglob

# Find directories containing package.json (ignoring node_modules) and run npm install
echo "Finding package.json files and running npm install..."
find "$SCRIPT_DIR" -name "node_modules" -prune -o -name "package.json" -print | while read -r pkg_path; do
  if [[ "$pkg_path" == *"package.json"* ]]; then
    pkg_dir=$(dirname "$pkg_path")
    echo "--------------------------------------------------"
    echo "Running npm install in: $pkg_dir"
    echo "--------------------------------------------------"
    (cd "$pkg_dir" && npm install)
  fi
done

echo "Update complete!"
