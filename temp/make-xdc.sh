#!/usr/bin/env bash
# Package the app as a .xdc (zip) file for sharing in Delta Chat.
# The archive excludes ./temp/, ./git-assets/ and ./README.md.
set -euo pipefail

# Run from the project root regardless of where the script is invoked from.
cd "$(dirname "$0")/.."

OUT="temp/app.xdc"

rm -f "$OUT"
zip -r "$OUT" . \
  -x "./temp/*" \
  -x "./git-assets/*" \
  -x "./README.md" \
  -x "./.git/*" \
  -x "./.github/*"

echo "Created $OUT"
