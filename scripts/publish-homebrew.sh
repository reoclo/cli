#!/usr/bin/env bash
# Publish/refresh the Homebrew formula for reoclo on the tap repo.
#
# Renders packaging/homebrew/reoclo.rb.tmpl with the current tag and the four
# darwin/linux SHA256s pulled from dist/SHA256SUMS, then commits the result to
# Formula/reoclo.rb on the tap repo and pushes.
#
# Required env:
#   CI_COMMIT_TAG        — release tag, e.g. v0.34.0 (set by Woodpecker on tag events)
#   HOMEBREW_TAP_TOKEN   — GitHub PAT with contents:write on HOMEBREW_TAP_REPO
#
# Optional env (with defaults):
#   HOMEBREW_TAP_REPO    — owner/repo of the tap (default: reoclo/homebrew-tap)
#   HOMEBREW_TAP_BRANCH  — branch to commit on   (default: main)
#   GIT_AUTHOR_NAME      — commit author name    (default: reoclo-release-bot)
#   GIT_AUTHOR_EMAIL     — commit author email   (default: release-bot@reoclo.com)
#
# Pre-built artifacts expected at:
#   dist/SHA256SUMS
#
# If HOMEBREW_TAP_TOKEN is unset, this script logs a warning and exits 0 so
# the first release (before the secret is provisioned) does not fail.
# Otherwise it is idempotent: re-running on the same tag produces an
# identical formula and skips the commit when nothing changed.

set -euo pipefail

TAG="${CI_COMMIT_TAG:?CI_COMMIT_TAG must be set (this script must run on a tag event)}"
VERSION="${TAG#v}"

TAP_REPO="${HOMEBREW_TAP_REPO:-reoclo/homebrew-tap}"
TAP_BRANCH="${HOMEBREW_TAP_BRANCH:-main}"
COMMIT_NAME="${GIT_AUTHOR_NAME:-reoclo-release-bot}"
COMMIT_EMAIL="${GIT_AUTHOR_EMAIL:-release-bot@reoclo.com}"

TEMPLATE="packaging/homebrew/reoclo.rb.tmpl"
SUMS="dist/SHA256SUMS"

[ -f "$TEMPLATE" ] || { echo "missing template: $TEMPLATE"; exit 1; }
[ -f "$SUMS" ]     || { echo "missing checksums: $SUMS";   exit 1; }

if [ -z "${HOMEBREW_TAP_TOKEN:-}" ]; then
  echo "==> Homebrew publish: HOMEBREW_TAP_TOKEN not set — skipping."
  echo "    Add the secret in Woodpecker to enable tap updates."
  exit 0
fi

echo "==> Homebrew publish for $TAG → $TAP_REPO ($TAP_BRANCH)"

# Pull the four SHAs we need from SHA256SUMS. The file shape is:
#   <sha256>  reoclo-<target>
# Use awk with an exact filename match so we never pick up a substring.
sha_for() {
  local target="$1"
  awk -v t="reoclo-$target" '$2 == t { print $1; found=1; exit } END { if (!found) exit 1 }' "$SUMS" \
    || { echo "checksum not found for reoclo-$target in $SUMS"; exit 1; }
}

SHA_DARWIN_X64=$(sha_for darwin-x64)
SHA_DARWIN_ARM64=$(sha_for darwin-arm64)
SHA_LINUX_X64=$(sha_for linux-x64)
SHA_LINUX_ARM64=$(sha_for linux-arm64)

# Render formula.
RENDERED=$(mktemp)
trap 'rm -f "$RENDERED"' EXIT

sed \
  -e "s|{{VERSION}}|$VERSION|g" \
  -e "s|{{SHA_DARWIN_X64}}|$SHA_DARWIN_X64|g" \
  -e "s|{{SHA_DARWIN_ARM64}}|$SHA_DARWIN_ARM64|g" \
  -e "s|{{SHA_LINUX_X64}}|$SHA_LINUX_X64|g" \
  -e "s|{{SHA_LINUX_ARM64}}|$SHA_LINUX_ARM64|g" \
  "$TEMPLATE" > "$RENDERED"

# Fail loudly if any placeholder slipped through (e.g. template added a new var).
if grep -q '{{' "$RENDERED"; then
  echo "unrendered placeholders remain in formula:"
  grep '{{' "$RENDERED"
  exit 1
fi

# Clone the tap, write the formula, push if changed.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"; rm -f "$RENDERED"' EXIT

CLONE_URL="https://x-access-token:${HOMEBREW_TAP_TOKEN}@github.com/${TAP_REPO}.git"

# Shallow clone is enough — we only need HEAD of TAP_BRANCH to diff/commit.
git clone --depth 1 --branch "$TAP_BRANCH" "$CLONE_URL" "$WORK/tap" 2>&1 \
  | sed "s|${HOMEBREW_TAP_TOKEN}|***|g"

mkdir -p "$WORK/tap/Formula"
DEST="$WORK/tap/Formula/reoclo.rb"

if [ -f "$DEST" ] && cmp -s "$RENDERED" "$DEST"; then
  echo "  Formula/reoclo.rb is already up to date for $TAG — nothing to commit."
  exit 0
fi

cp "$RENDERED" "$DEST"

cd "$WORK/tap"
git -c user.name="$COMMIT_NAME" -c user.email="$COMMIT_EMAIL" add Formula/reoclo.rb
git -c user.name="$COMMIT_NAME" -c user.email="$COMMIT_EMAIL" \
  commit -m "reoclo $TAG"

# Hide the token in any push output.
git push origin "$TAP_BRANCH" 2>&1 | sed "s|${HOMEBREW_TAP_TOKEN}|***|g"

echo "==> Tap updated: Formula/reoclo.rb @ $TAG"
