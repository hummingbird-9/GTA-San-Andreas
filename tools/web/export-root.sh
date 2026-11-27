#!/bin/sh
# Build the browser runtime and mirror its deployable files into the repository root.
# After running this, commit the generated root runtime files to main for branch-root hosting.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

JOBS="${JOBS:-2}" "$root/tools/web/build.sh"

for file in sa_game.js sa_game_bg.wasm; do
  if [ ! -s "$root/web/pkg/$file" ]; then
    echo "export-root.sh: missing web/pkg/$file after the build" >&2
    exit 1
  fi
done

# These paths are intentionally relative so the same build works at / and at
# a GitHub Pages project path such as /GTA-San-Andreas/.
for file in index.html main.js worker.js loader.js audio-worklet.js mods.js favicon.svg; do
  cp "$root/web/$file" "$root/$file"
done

mkdir -p "$root/pkg"
cp "$root/web/pkg/sa_game.js" "$root/pkg/sa_game.js"
cp "$root/web/pkg/sa_game_bg.wasm" "$root/pkg/sa_game_bg.wasm"

echo "Root browser site prepared."
echo "Review and commit: index.html main.js worker.js loader.js audio-worklet.js mods.js pkg/"
echo "GitHub Pages source: main / (root) (only after resolving the privacy warning in docs/WEB-DEPLOYMENT.md)."
