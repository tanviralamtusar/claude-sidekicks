#!/usr/bin/env bash
# claude-sidekicks installer for macOS / Linux.
#   bash install.sh              install or update
#   bash install.sh --uninstall  remove everything again
# No sudo needed: it only edits config files in your home folder.
# The real work happens in install.mjs; this just finds Node.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "✗ node not found. Install Node.js 18 or newer: https://nodejs.org" >&2
  exit 1
fi
exec node "$DIR/install.mjs" "$@"
