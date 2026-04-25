#!/usr/bin/env bash
# scripts/release-github.sh — mirror the release to github.com/reoclo/cli.
#
# Required env:
#   CI_COMMIT_TAG   the tag being released (e.g. v0.9.0)
#   GITHUB_TOKEN    PAT with `repo` scope on reoclo/cli
#
# Uses the gh CLI. The tag must already exist on the GitHub remote.
set -euo pipefail

TAG="${CI_COMMIT_TAG:?CI_COMMIT_TAG required}"
TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN required}"
REPO="${GITHUB_REPO:-reoclo/cli}"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required but not on PATH" >&2
  exit 1
fi

if [[ ! -d dist ]]; then
  echo "dist/ not found — run 'bun run build' first" >&2
  exit 1
fi

shopt -s nullglob
ASSETS=(dist/reoclo-* dist/SHA256SUMS)
if [[ ${#ASSETS[@]} -eq 0 ]]; then
  echo "no release assets found in dist/" >&2
  exit 1
fi

export GH_TOKEN="${TOKEN}"

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "  release ${TAG} already exists, uploading assets only"
  gh release upload "$TAG" "${ASSETS[@]}" --repo "$REPO" --clobber
else
  gh release create "$TAG" "${ASSETS[@]}" \
    --repo "$REPO" \
    --title "$TAG" \
    --notes "Release $TAG" \
    --verify-tag
fi

echo "✓ GitHub release ${TAG} created with ${#ASSETS[@]} asset(s)"
