#!/usr/bin/env bash
# Release script for reoclo-cli.
#
# Publishes the current tag as a release on both mirrors:
#   - Gitea  (git.boxpositron.dev/reoclo/reoclo-cli)
#   - GitHub (github.com/reoclo/cli)
#
# Required env:
#   CI_COMMIT_TAG    — set by Woodpecker on tag events (e.g. v0.19.0)
#   GITEA_API_URL    — e.g. https://git.boxpositron.dev/api/v1
#   GITEA_REPO       — e.g. reoclo/reoclo-cli
#   GITHUB_REPO      — e.g. reoclo/cli
#   GITEA_TOKEN      — Woodpecker secret: gitea_release_token
#   GITHUB_TOKEN     — Woodpecker secret: github_release_token
#
# Pre-built artifacts expected at:
#   dist/SHA256SUMS
#   dist/reoclo-{darwin-arm64,darwin-x64,linux-arm64,linux-x64,linux-x64-musl,windows-x64.exe}
#
# Idempotent on rerun: an existing release with the same tag is reused, and
# assets that are already attached are skipped.

set -euo pipefail

TAG="${CI_COMMIT_TAG:?CI_COMMIT_TAG must be set (this script must run on a tag event)}"
NAME="$TAG"
BODY="Release $TAG"

ASSETS=(
  "dist/SHA256SUMS"
  "dist/reoclo-darwin-arm64"
  "dist/reoclo-darwin-x64"
  "dist/reoclo-linux-arm64"
  "dist/reoclo-linux-x64"
  "dist/reoclo-linux-x64-musl"
  "dist/reoclo-windows-x64.exe"
  "packaging/install.sh"
)

for f in "${ASSETS[@]}"; do
  [ -f "$f" ] || { echo "missing artifact: $f"; exit 1; }
done

echo "==> Releasing $TAG"

# ---------------------------------------------------------------------------
# Gitea
# ---------------------------------------------------------------------------

echo "==> Gitea: ensure release for $TAG"

GITEA_RELEASE_ID=$(curl -fsS \
  -H "Authorization: token $GITEA_TOKEN" \
  "$GITEA_API_URL/repos/$GITEA_REPO/releases/tags/$TAG" 2>/dev/null \
  | jq -r '.id // empty' || true)

if [ -z "${GITEA_RELEASE_ID:-}" ]; then
  GITEA_RELEASE_ID=$(curl -fsS -X POST \
    -H "Authorization: token $GITEA_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg t "$TAG" --arg n "$NAME" --arg b "$BODY" \
          '{tag_name:$t,name:$n,body:$b,draft:false,prerelease:false}')" \
    "$GITEA_API_URL/repos/$GITEA_REPO/releases" | jq -r '.id')
  echo "  Gitea release created: $GITEA_RELEASE_ID"
else
  echo "  Gitea release exists: $GITEA_RELEASE_ID"
fi

EXISTING_GITEA_ASSETS=$(curl -fsS \
  -H "Authorization: token $GITEA_TOKEN" \
  "$GITEA_API_URL/repos/$GITEA_REPO/releases/$GITEA_RELEASE_ID/assets" \
  | jq -r '.[].name')

for f in "${ASSETS[@]}"; do
  name="$(basename "$f")"
  if printf '%s\n' "$EXISTING_GITEA_ASSETS" | grep -Fxq "$name"; then
    echo "  • Gitea $name — already present, skipping"
    continue
  fi
  echo "  • Gitea $name — uploading"
  curl -fsS -X POST \
    -H "Authorization: token $GITEA_TOKEN" \
    -F "attachment=@$f" \
    "$GITEA_API_URL/repos/$GITEA_REPO/releases/$GITEA_RELEASE_ID/assets?name=$name" \
    > /dev/null
done

# ---------------------------------------------------------------------------
# GitHub
# ---------------------------------------------------------------------------

echo "==> GitHub: ensure release for $TAG"

GH_API="https://api.github.com"
GH_UPLOAD="https://uploads.github.com"

GH_RELEASE=$(curl -fsS \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "$GH_API/repos/$GITHUB_REPO/releases/tags/$TAG" 2>/dev/null || echo "")

GH_RELEASE_ID=$(echo "$GH_RELEASE" | jq -r '.id // empty' 2>/dev/null || echo "")

if [ -z "${GH_RELEASE_ID:-}" ]; then
  GH_RELEASE=$(curl -fsS -X POST \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg t "$TAG" --arg n "$NAME" --arg b "$BODY" \
          '{tag_name:$t,name:$n,body:$b,draft:false,prerelease:false}')" \
    "$GH_API/repos/$GITHUB_REPO/releases")
  GH_RELEASE_ID=$(echo "$GH_RELEASE" | jq -r '.id')
  echo "  GitHub release created: $GH_RELEASE_ID"
else
  echo "  GitHub release exists: $GH_RELEASE_ID"
fi

EXISTING_GH_ASSETS=$(echo "$GH_RELEASE" | jq -r '.assets[]?.name')

for f in "${ASSETS[@]}"; do
  name="$(basename "$f")"
  if printf '%s\n' "$EXISTING_GH_ASSETS" | grep -Fxq "$name"; then
    echo "  • GitHub $name — already present, skipping"
    continue
  fi
  echo "  • GitHub $name — uploading"
  curl -fsS -X POST \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$f" \
    "$GH_UPLOAD/repos/$GITHUB_REPO/releases/$GH_RELEASE_ID/assets?name=$name" \
    > /dev/null
done

echo "==> Done."
