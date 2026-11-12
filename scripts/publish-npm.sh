#!/usr/bin/env bash
# scripts/publish-npm.sh
#
# Publishes the npm packages for a release tag: one package per platform
# (@reoclo/cli-<os>-<cpu>, holding that platform's binary from dist/) and the
# @reoclo/cli shim (packaging/npm-shim), which lists them as optional
# dependencies and runs the one that matches the machine. Installing
# @reoclo/cli gives both `reoclo` and `rc`.
#
# Runs from .github/workflows/npm-publish.yml on the GitHub mirror, which
# publishes through npm trusted publishing (OIDC): no npm token is stored
# anywhere, and npm adds provenance on its own.
#
# Env:
#   TAG        the release tag (vX.Y.Z); must match package.json
#   DRY_RUN=1  pack and check every package without publishing
#
# Platform packages go first so the shim's optional dependencies exist when it
# is published. Re-running a tag is safe: versions already on the registry are
# skipped.
set -euo pipefail

TAG="${TAG:?TAG must be set to the release tag (vX.Y.Z)}"
VER="${TAG#v}"
DRY_RUN="${DRY_RUN:-}"

PKG_VER="$(jq -r '.version' package.json)"
if [ "$PKG_VER" != "$VER" ]; then
  echo "npm: tag $TAG does not match package.json version $PKG_VER" >&2
  exit 1
fi

PUBLISH_ARGS=(--access public)
if [ -n "$DRY_RUN" ]; then
  PUBLISH_ARGS+=(--dry-run)
  echo "==> npm: dry run for $TAG"
else
  echo "==> npm: publishing $TAG"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

publish() {
  local name="$1" dir="$2"
  if [ -z "$DRY_RUN" ] && [ "$(npm view "$name@$VER" version 2>/dev/null || true)" = "$VER" ]; then
    echo "  $name@$VER is already published; skipping"
    return
  fi
  echo "  $name@$VER"
  # npm silently drops package.json fields it considers invalid (npm 12 drops
  # a bin path written as "./bin.js"), which would publish a shim with no
  # commands. Refuse to publish anything npm had to correct.
  local check
  check="$(cd "$dir" && npm publish --access public --dry-run 2>&1)"
  if grep -q "auto-corrected" <<<"$check"; then
    echo "$check" >&2
    echo "npm: $name's package.json needs fixing before it can be published" >&2
    exit 1
  fi
  (cd "$dir" && npm publish "${PUBLISH_ARGS[@]}")
}

publish_platform() {
  local os="$1" cpu="$2" artifact="$3"
  local suffix="$os"
  [ "$os" = "win32" ] && suffix="windows"
  local name="@reoclo/cli-$suffix-$cpu"
  local exe="reoclo"
  [ "$os" = "win32" ] && exe="reoclo.exe"
  local dir="$WORK/$suffix-$cpu"
  mkdir -p "$dir"
  [ -f "dist/$artifact" ] || { echo "npm: missing artifact dist/$artifact" >&2; exit 1; }
  cp "dist/$artifact" "$dir/$exe"
  chmod 755 "$dir/$exe"
  jq -n --arg name "$name" --arg ver "$VER" --arg os "$os" --arg cpu "$cpu" \
    '{name: $name, version: $ver, description: "Reoclo CLI binary for \($os)-\($cpu); install @reoclo/cli instead", license: "MIT", homepage: "https://reoclo.com", repository: {type: "git", url: "git+https://github.com/reoclo/cli.git"}, os: [$os], cpu: [$cpu]}' \
    > "$dir/package.json"
  publish "$name" "$dir"
}

publish_platform linux  x64   reoclo-linux-x64
publish_platform linux  arm64 reoclo-linux-arm64
publish_platform darwin x64   reoclo-darwin-x64
publish_platform darwin arm64 reoclo-darwin-arm64
publish_platform win32  x64   reoclo-windows-x64.exe

SHIM="$WORK/cli"
cp -R packaging/npm-shim/. "$SHIM/"
chmod 755 "$SHIM/bin.js"
jq --arg ver "$VER" '.version = $ver | .optionalDependencies |= with_entries(.value = $ver)' \
  packaging/npm-shim/package.json > "$SHIM/package.json"
publish "@reoclo/cli" "$SHIM"

echo "==> npm: done for $TAG"
