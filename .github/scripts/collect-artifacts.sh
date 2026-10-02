#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
#
# Usage: collect-artifacts.sh <dest-dir> <label>=<glob> [<label>=<glob> ...]
#
# Copies every file matching each glob into <dest-dir>, logs its size and
# SHA-256, and appends a table to the job summary. A glob that matches nothing
# fails the step and lists what the build did produce in that directory, which
# is far easier to diagnose than an artifact that silently uploads empty.
set -euo pipefail
shopt -s nullglob

dest=$1
shift
mkdir -p "$dest"
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
missing=0

{
  echo "### Artifacts"
  echo
  echo "| Kind | File | Size | SHA-256 |"
  echo "|------|------|-----:|---------|"
} >> "$summary"

for spec in "$@"; do
  label=${spec%%=*}
  pattern=${spec#*=}
  # Patterns never contain spaces, but the files they match can (Tauri names
  # bundles after productName), so expand unquoted and keep each match whole.
  # shellcheck disable=SC2206
  matches=( $pattern )
  if (( ${#matches[@]} == 0 )); then
    dir=$(dirname "$pattern")
    echo "::error title=Missing build output ($label)::Nothing matched '$pattern'. The build step exited successfully but did not produce this file; check its log for a skipped or failed bundle target."
    echo "Contents of $dir:"
    ls -la "$dir" 2>/dev/null || echo "  (directory does not exist)"
    missing=1
    continue
  fi
  for f in "${matches[@]}"; do
    size=$(du -h "$f" | cut -f1)
    sum=$(sha256sum "$f" | cut -d' ' -f1)
    echo "$label: $f ($size, sha256 $sum)"
    cp "$f" "$dest/"
    echo "| $label | \`$(basename "$f")\` | $size | \`$sum\` |" >> "$summary"
  done
done

exit "$missing"
