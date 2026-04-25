#!/usr/bin/env bash
# scripts/publish-npm.sh
# Publish per-platform packages, the main shim, and the @reoclo/theta back-compat shim.
# Required env: CI_COMMIT_TAG, NPM_TOKEN
set -euo pipefail

TAG="${CI_COMMIT_TAG:?tag required}"
VER="${TAG#v}"

publish_platform() {
  local name="$1" bin="$2"
  local dir; dir=$(mktemp -d)
  local cpu="x64"
  local os="linux"
  case "$name" in
    *darwin*)  os="darwin"; ;;
    *linux*)   os="linux";  ;;
    *windows*) os="win32";  ;;
  esac
  case "$name" in
    *arm64*) cpu="arm64"; ;;
    *x64*)   cpu="x64";   ;;
  esac
  cat > "$dir/package.json" <<EOF
{
  "name": "$name",
  "version": "$VER",
  "license": "MIT",
  "os": ["$os"],
  "cpu": ["$cpu"]
}
EOF
  local out_name="reoclo"
  [[ "$os" == "win32" ]] && out_name="reoclo.exe"
  cp "$bin" "$dir/$out_name"
  (cd "$dir" && npm publish --access public --provenance)
}

publish_platform "@reoclo/cli-linux-x64"     "dist/reoclo-linux-x64"
publish_platform "@reoclo/cli-linux-arm64"   "dist/reoclo-linux-arm64"
publish_platform "@reoclo/cli-darwin-x64"    "dist/reoclo-darwin-x64"
publish_platform "@reoclo/cli-darwin-arm64"  "dist/reoclo-darwin-arm64"
publish_platform "@reoclo/cli-windows-x64"   "dist/reoclo-windows-x64.exe"

# Main @reoclo/cli shim
MAIN_DIR=$(mktemp -d)
cp -R packaging/npm-shim/. "$MAIN_DIR/"
sed -i.bak "s/0.0.0-placeholder/$VER/g" "$MAIN_DIR/package.json"
rm "$MAIN_DIR/package.json.bak"
(cd "$MAIN_DIR" && npm publish --access public --provenance)

# @reoclo/theta back-compat shim
THETA_DIR=$(mktemp -d)
cp -R packaging/npm-shim-theta/. "$THETA_DIR/"
sed -i.bak "s/\"version\": \".*\"/\"version\": \"$VER\"/" "$THETA_DIR/package.json"
sed -i.bak "s/const VERSION = \".*\"/const VERSION = \"$VER\"/" "$THETA_DIR/bin.js"
rm "$THETA_DIR"/*.bak
(cd "$THETA_DIR" && npm publish --access public --provenance)

echo "✓ published all npm packages at $VER"
