#!/bin/bash
# Build a portable macOS zip from the current git commit.
#
# Using git archive (instead of zip -r) preserves the executable bit on
# "Start Me.command", so it stays double-clickable after unzipping on macOS.
#
#   bash tools/package-mac.sh
#
# Output: dist/RoninS-Ctrl-Plus-mac-portable.zip

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

if ! command -v git >/dev/null 2>&1; then
  echo "git is required to build the zip (it preserves file permissions)." >&2
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Run this from a git checkout of RoninS-Ctrl-Plus." >&2
  exit 1
fi

mkdir -p dist
OUT="dist/RoninS-Ctrl-Plus-mac-portable.zip"
rm -f "$OUT"

git archive \
  --format=zip \
  --prefix=RoninS-Ctrl-Plus/ \
  -o "$OUT" \
  HEAD

if [ ! -s "$OUT" ]; then
  echo "Zip was not created." >&2
  exit 1
fi

echo ""
echo "Created $OUT"
echo "Unzip it on the Mac, then double-click \"Start Me.command\"."
