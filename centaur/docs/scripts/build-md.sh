#!/usr/bin/env bash
# Copies MDX pages into public/md/ as plain .md files so agents can curl them.
# Run before vocs build, or as part of the build step.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf public/md
mkdir -p public/md

find pages -name '*.mdx' | while read -r src; do
  dest="public/md/${src#pages/}"
  dest="${dest%.mdx}.md"
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
done

echo "Copied $(find public/md -name '*.md' | wc -l | tr -d ' ') markdown files to public/md/"
