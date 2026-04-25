#!/usr/bin/env bash
# scripts/update-homebrew.sh
# Renders packaging/homebrew/reoclo.rb.tmpl with this release's version + checksums
# and pushes Formula/reoclo.rb to reoclo/homebrew-tap on GitHub.
#
# Required env: CI_COMMIT_TAG, GITHUB_TOKEN
set -euo pipefail

TAG="${CI_COMMIT_TAG:?tag required}"
VER="${TAG#v}"

SHA_DARWIN_X64=$(grep "reoclo-darwin-x64$" dist/SHA256SUMS | awk '{print $1}')
SHA_DARWIN_ARM64=$(grep "reoclo-darwin-arm64$" dist/SHA256SUMS | awk '{print $1}')
SHA_LINUX_X64=$(grep "reoclo-linux-x64$" dist/SHA256SUMS | awk '{print $1}')
SHA_LINUX_ARM64=$(grep "reoclo-linux-arm64$" dist/SHA256SUMS | awk '{print $1}')

RENDERED=$(mktemp)
sed -e "s|{{VERSION}}|${VER}|g" \
    -e "s|{{SHA_DARWIN_X64}}|${SHA_DARWIN_X64}|g" \
    -e "s|{{SHA_DARWIN_ARM64}}|${SHA_DARWIN_ARM64}|g" \
    -e "s|{{SHA_LINUX_X64}}|${SHA_LINUX_X64}|g" \
    -e "s|{{SHA_LINUX_ARM64}}|${SHA_LINUX_ARM64}|g" \
    packaging/homebrew/reoclo.rb.tmpl > "$RENDERED"

git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/reoclo/homebrew-tap.git" /tmp/tap
mkdir -p /tmp/tap/Formula
cp "$RENDERED" /tmp/tap/Formula/reoclo.rb
cd /tmp/tap
git add Formula/reoclo.rb
git -c user.email=ci@reoclo.com -c user.name="Reoclo CI" \
  commit -m "reoclo ${VER}" || echo "no changes to commit"
git push origin HEAD
echo "✓ homebrew formula bumped to ${VER}"
