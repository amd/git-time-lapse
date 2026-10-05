#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
#
# Usage: stage-release-assets.sh <downloaded-artifacts-dir> <dest-dir> <version>
#
# The build workflows upload one artifact per platform, named
# git-time-lapse-<platform>, holding the files under their bundler names. Those
# names contain spaces, repeat the version, and collide across platforms (the
# Linux and both macOS portable binaries are all `git-time-lapse`), so copy
# each into <dest-dir> as git-time-lapse-<version>-<platform>[.<ext>], then
# write SHA256SUMS.txt. Fails on an unknown artifact or file, or a name
# collision, rather than publish an incomplete or ambiguous release.
set -euo pipefail
shopt -s nullglob

src=$1 dest=$2 version=$3
mkdir -p "$dest"
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
fail=0

put() {
  local from=$1 name=$2
  if [ -e "$dest/$name" ]; then
    echo "::error title=Asset name collision::$name would be produced twice (second source: $from)."
    fail=1
    return
  fi
  cp "$from" "$dest/$name"
  echo "$from -> $name"
}

dirs=("$src"/git-time-lapse-*/)
(( ${#dirs[@]} )) || { echo "::error title=No artifacts::Nothing matched $src/git-time-lapse-*/."; exit 1; }

for dir in "${dirs[@]}"; do
  artifact=$(basename "$dir")
  case $artifact in
    git-time-lapse-tauri-v2-windows)     platform=windows-x64 ;;
    git-time-lapse-tauri-v2-linux)       platform=linux-x86_64 ;;
    git-time-lapse-tauri-v1-linux-el8)   platform=linux-x86_64-rhel8 ;;
    git-time-lapse-tauri-v2-macos-arm64) platform=macos-arm64 ;;
    git-time-lapse-tauri-v2-macos-x64)   platform=macos-x64 ;;
    git-time-lapse-vscode)               platform=vscode ;;
    git-time-lapse-visual-studio)        platform=visual-studio ;;
    *) echo "::error title=Unknown artifact::$artifact has no asset naming rule in stage-release-assets.sh."; fail=1; continue ;;
  esac
  for f in "$dir"*; do
    base=$(basename "$f")
    case $base in
      *.exe|*.deb|*.rpm|*.AppImage|*.dmg|*.vsix)
                                        put "$f" "git-time-lapse-$version-$platform.${base##*.}" ;;
      *.*) echo "::error title=Unknown asset::$artifact/$base has no naming rule in stage-release-assets.sh."; fail=1 ;;
      # No extension: the portable Linux/macOS binary (Tauri v1 names it after
      # productName, v2 after the crate).
      *)                                put "$f" "git-time-lapse-$version-$platform" ;;
    esac
  done
done

[ "$fail" = 0 ] || exit 1
(cd "$dest" && sha256sum -- * > SHA256SUMS.txt)
{
  echo "### Release assets"
  echo
  echo '```'
  cat "$dest/SHA256SUMS.txt"
  echo '```'
} >> "$summary"
cat "$dest/SHA256SUMS.txt"
