#!/usr/bin/env bash
# Builds the web app for the desktop app into desktop/.build/app-dist (no source maps, no debug tools), then stages it.
# Usage: desktop/scripts/build-app.sh   (from anywhere; needs `npm ci` in app/ and desktop/)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$here/.build/app-dist"
cd "$here/../app"
npx vite build --outDir "$out" --emptyOutDir --logLevel warn
node "$here/scripts/stage.mjs" --app-dist "$out"
