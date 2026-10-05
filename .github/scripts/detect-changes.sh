#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
#
# Usage: detect-changes.sh <path-prefix> [<path-prefix> ...]
#
# Writes build=true or build=false to $GITHUB_OUTPUT depending on whether any
# file changed by this event starts with one of the prefixes. Path filtering is
# done here rather than with `on.<event>.paths` because a workflow skipped by a
# trigger filter never reports its checks, so they could not be required.
#
# Reads EVENT_NAME, REF_TYPE, BASE_SHA and HEAD_SHA from the environment. Tag
# builds (releases) always build. Anything that prevents an accurate diff
# (manual dispatch, a new branch, a force push that dropped the old tip) builds
# everything rather than risk skipping a build.
set -euo pipefail

out=${GITHUB_OUTPUT:-/dev/stdout}
summary=${GITHUB_STEP_SUMMARY:-/dev/null}

build_all() {
  echo "Building: $1"
  echo "build=true" >> "$out"
  echo "Build forced: $1" >> "$summary"
  exit 0
}

[ "${EVENT_NAME:-}" = workflow_dispatch ] && build_all "manual dispatch"
[ "${REF_TYPE:-}" = tag ] && build_all "tag build"
[ -n "${BASE_SHA:-}" ] && [ -n "${HEAD_SHA:-}" ] || build_all "no base/head commit for this event"
[ "$BASE_SHA" = 0000000000000000000000000000000000000000 ] && build_all "no previous commit (new branch)"
git cat-file -e "$BASE_SHA^{commit}" 2>/dev/null || build_all "base commit $BASE_SHA is not available"

# Three dots: only what the head side changed since the merge base, so commits
# that landed on the base branch after the PR was opened do not count.
changed=$(git diff --name-only "$BASE_SHA...$HEAD_SHA")

matched=()
while IFS= read -r f; do
  [ -n "$f" ] || continue
  for p in "$@"; do
    if [[ $f == "$p"* ]]; then
      matched+=("$f")
      break
    fi
  done
done <<< "$changed"

echo "Watched paths: $*"
if (( ${#matched[@]} )); then
  echo "Relevant changes:"
  printf '  %s\n' "${matched[@]}"
  echo "build=true" >> "$out"
else
  echo "No changes under the watched paths; the build jobs will skip their steps and pass."
  echo "build=false" >> "$out"
  echo "No changes under \`$*\`; build skipped." >> "$summary"
fi
