#!/usr/bin/env bash
# scripts/release-gitea.sh — upload built binaries + checksums to a Gitea release.
#
# Required env:
#   CI_COMMIT_TAG   the tag being released (e.g. v0.9.0)
#   GITEA_TOKEN     PAT with repo write on git.boxpositron.dev/reoclo/reoclo-cli
#
# Reads from dist/: every reoclo-* binary plus SHA256SUMS.
set -euo pipefail

TAG="${CI_COMMIT_TAG:?CI_COMMIT_TAG required}"
TOKEN="${GITEA_TOKEN:?GITEA_TOKEN required}"
REPO="${GITEA_REPO:-reoclo/reoclo-cli}"
HOST="${GITEA_HOST:-git.boxpositron.dev}"
BASE="https://${HOST}/api/v1/repos/${REPO}/releases"
AUTH=(-H "Authorization: token ${TOKEN}")

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

# Create release (or look it up if it already exists, e.g. on re-run).
REL_JSON=$(curl -sf -X POST "$BASE" "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d "{\"tag_name\":\"${TAG}\",\"name\":\"${TAG}\",\"body\":\"Release ${TAG}\"}" \
  || true)

if [[ -z "$REL_JSON" ]]; then
  REL_JSON=$(curl -sf "${BASE}/tags/${TAG}" "${AUTH[@]}")
fi

REL_ID=$(printf '%s' "$REL_JSON" | jq -r .id)
if [[ -z "$REL_ID" || "$REL_ID" == "null" ]]; then
  echo "could not resolve release id for ${TAG}" >&2
  printf '%s\n' "$REL_JSON" >&2
  exit 1
fi

for f in "${ASSETS[@]}"; do
  NAME=$(basename "$f")
  echo "  uploading ${NAME}"
  curl -sf -X POST "${BASE}/${REL_ID}/assets?name=${NAME}" \
    "${AUTH[@]}" \
    -F "attachment=@${f}" >/dev/null
done

echo "✓ Gitea release ${TAG} created with ${#ASSETS[@]} asset(s)"
