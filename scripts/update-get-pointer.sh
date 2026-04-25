#!/usr/bin/env bash
# scripts/update-get-pointer.sh
# Updates https://get.reoclo.com/cli/{channel} text file with the new tag.
# Required env: CI_COMMIT_TAG, DEPLOY_HOST, DEPLOY_KEY
set -euo pipefail

TAG="${CI_COMMIT_TAG:?tag required}"

# Write deploy key to a temp file with restrictive perms
KEYFILE=$(mktemp)
chmod 600 "$KEYFILE"
echo "$DEPLOY_KEY" > "$KEYFILE"

ssh -i "$KEYFILE" -o StrictHostKeyChecking=no "deploy@${DEPLOY_HOST}" \
  "echo '${TAG}' > /srv/get.reoclo.com/cli/stable"

rm -f "$KEYFILE"
echo "✓ pointer updated to ${TAG}"
