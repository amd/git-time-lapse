#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
#
# Usage: check-release-version.sh <tag>
#
# Fails unless every version field listed under "Version Bumping" in AGENTS.md
# matches the tag, so a tag pushed before (or without) the version bump cannot
# publish assets that report a different version. A pre-release suffix on the
# tag (v1.2.0-rc1) is ignored for the comparison, since the VS Code and VSIX
# manifests cannot carry one. Writes version=<X.Y.Z> to $GITHUB_OUTPUT.
set -euo pipefail

tag=$1
[[ $tag =~ ^v([0-9]+\.[0-9]+\.[0-9]+)(-[0-9A-Za-z.-]+)?$ ]] || {
  echo "::error title=Bad tag::'$tag' is not v<major>.<minor>.<patch>, optionally followed by -<pre-release>."
  exit 1
}
want=${BASH_REMATCH[1]}
out=${GITHUB_OUTPUT:-/dev/null}
fail=0

check() {
  local file=$1 what=$2 got=$3 expect=$4
  if [ "$got" = "$expect" ]; then
    echo "ok   $file ($what): $got"
  else
    echo "::error file=$file,title=Version mismatch::$file $what is '$got', expected '$expect' for tag $tag. Bump every field listed in AGENTS.md, merge, then move the tag."
    fail=1
  fi
}

product="Git Time-Lapse View v$want"
check tauri/package.json version "$(jq -r .version tauri/package.json)" "$want"
check tauri/package-lock.json version "$(jq -r .version tauri/package-lock.json)" "$want"
check tauri/src-tauri/tauri.conf.json version "$(jq -r .version tauri/src-tauri/tauri.conf.json)" "$want"
check tauri/src-tauri/tauri.conf.json productName "$(jq -r .productName tauri/src-tauri/tauri.conf.json)" "$product"
check tauri/src-tauri/Cargo.toml version "$(sed -n 's/^version = "\(.*\)"/\1/p' tauri/src-tauri/Cargo.toml | head -n1)" "$want"
check tauri/src-tauri-v1/tauri.conf.json package.version "$(jq -r .package.version tauri/src-tauri-v1/tauri.conf.json)" "$want"
check tauri/src-tauri-v1/tauri.conf.json package.productName "$(jq -r .package.productName tauri/src-tauri-v1/tauri.conf.json)" "$product"
check tauri/src-tauri-v1/Cargo.toml version "$(sed -n 's/^version = "\(.*\)"/\1/p' tauri/src-tauri-v1/Cargo.toml | head -n1)" "$want"
check vscode/package.json version "$(jq -r .version vscode/package.json)" "$want"
check vscode/package-lock.json version "$(jq -r .version vscode/package-lock.json)" "$want"
check visual-studio/package.json version "$(jq -r .version visual-studio/package.json)" "$want"
check visual-studio/package-lock.json version "$(jq -r .version visual-studio/package-lock.json)" "$want"
check visual-studio/extension/source.extension.vsixmanifest Identity.Version \
  "$(grep -oE '<Identity [^>]*Version="[^"]+"' visual-studio/extension/source.extension.vsixmanifest | sed -E 's/.*Version="([^"]+)"/\1/')" "$want.0"
check visual-studio/extension/Properties/AssemblyInfo.cs AssemblyVersion \
  "$(sed -n 's/^\[assembly: AssemblyVersion("\(.*\)")\]/\1/p' visual-studio/extension/Properties/AssemblyInfo.cs)" "$want.0"
check visual-studio/extension/Properties/AssemblyInfo.cs AssemblyFileVersion \
  "$(sed -n 's/^\[assembly: AssemblyFileVersion("\(.*\)")\]/\1/p' visual-studio/extension/Properties/AssemblyInfo.cs)" "$want.0"

[ "$fail" = 0 ] || exit 1
echo "version=$want" >> "$out"
