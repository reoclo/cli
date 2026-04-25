#!/usr/bin/env bash
# scripts/update-get-pointer.sh — publish CLI install assets to the `cli` bucket.
#
# What it does (idempotent on every release):
#   1. Uploads packaging/install.sh -> s3://cli/install.sh
#   2. Writes the tag string to the channel pointer s3://cli/<channel>
#
# After this runs, both URLs return 200:
#   curl https://get.reoclo.com/cli            (rewrites to /cli/install.sh)
#   curl https://get.reoclo.com/cli/<channel>  (returns the tag string)
#
# Required env:
#   CI_COMMIT_TAG       the tag being released (e.g. v0.9.0)
#   MINIO_ENDPOINT_URL  S3 API URL (e.g. https://cdn.reoclo.com)
#   MINIO_ACCESS_KEY    S3 access key
#   MINIO_SECRET_KEY    S3 secret key
#
# Optional env:
#   CLI_BUCKET         bucket name (default: cli)
#   CLI_CHANNEL        which pointer to update (default: stable)
#                      Pass `beta` or `dev` for pre-release tags.
#   AWS_REGION         region (default: us-east-1; MinIO ignores)
set -euo pipefail

TAG="${CI_COMMIT_TAG:?CI_COMMIT_TAG required}"
ENDPOINT="${MINIO_ENDPOINT_URL:?MINIO_ENDPOINT_URL required}"
BUCKET="${CLI_BUCKET:-cli}"
CHANNEL="${CLI_CHANNEL:-stable}"

export AWS_ACCESS_KEY_ID="${MINIO_ACCESS_KEY:?MINIO_ACCESS_KEY required}"
export AWS_SECRET_ACCESS_KEY="${MINIO_SECRET_KEY:?MINIO_SECRET_KEY required}"
export AWS_DEFAULT_REGION="${AWS_REGION:-us-east-1}"

# The aws CLI is the most portable S3-compatible client and works with MinIO
# via --endpoint-url. Install on the fly if not already present (CI runner is
# Debian-based via the oven/bun image).
if ! command -v aws >/dev/null 2>&1; then
  echo "  installing aws-cli (one-shot)..."
  apt-get update -qq
  apt-get install -y --no-install-recommends awscli >/dev/null
fi

if [[ ! -f packaging/install.sh ]]; then
  echo "packaging/install.sh not found — run from cli/ root" >&2
  exit 1
fi

echo "  uploading install.sh -> s3://${BUCKET}/install.sh"
aws s3 cp packaging/install.sh "s3://${BUCKET}/install.sh" \
  --endpoint-url "${ENDPOINT}" \
  --content-type "text/x-shellscript" \
  --no-progress

echo "  setting ${CHANNEL} pointer -> ${TAG}"
printf '%s' "${TAG}" | aws s3 cp - "s3://${BUCKET}/${CHANNEL}" \
  --endpoint-url "${ENDPOINT}" \
  --content-type "text/plain" \
  --no-progress

echo "✓ pointer ${CHANNEL} = ${TAG}, install.sh refreshed"
