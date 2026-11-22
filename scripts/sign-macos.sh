#!/usr/bin/env bash
# Signs and notarizes the macOS release binaries with rcodesign, which runs on the Linux
# release image. Never print the signing environment.
#
# Required env (Woodpecker secrets, tag events only):
#   MACOS_DEVELOPER_ID_P12          base64 .p12 with only the Developer ID Application certificate
#                                   and its key; rcodesign signs with an intermediate if one is
#                                   bundled, and adds Apple's chain itself
#   MACOS_DEVELOPER_ID_P12_PASSWORD its password
#   ASC_API_KEY_JSON                App Store Connect API key, as written by
#                                   `rcodesign encode-app-store-connect-api-key`
set -euo pipefail

: "${MACOS_DEVELOPER_ID_P12:?MACOS_DEVELOPER_ID_P12 must be set}"
: "${MACOS_DEVELOPER_ID_P12_PASSWORD:?MACOS_DEVELOPER_ID_P12_PASSWORD must be set}"
: "${ASC_API_KEY_JSON:?ASC_API_KEY_JSON must be set}"
[ "$(uname -s)" = Linux ] || { echo "sign-macos: runs on the Linux release image only" >&2; exit 1; }

BINARIES=(dist/reoclo-darwin-arm64 dist/reoclo-darwin-x64)
for bin in "${BINARIES[@]}"; do
  [ -f "$bin" ] || { echo "sign-macos: missing $bin" >&2; exit 1; }
done

RCODESIGN_VERSION=0.29.0
case "$(uname -m)" in
  x86_64) triple=x86_64-unknown-linux-musl; sum=dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002 ;;
  aarch64 | arm64) triple=aarch64-unknown-linux-musl; sum=4af92c87ddf52f5f2d1258a3b4e56c7dcb8f1b2468df744976c5f139e031961f ;;
  *) echo "sign-macos: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tarball="apple-codesign-$RCODESIGN_VERSION-$triple.tar.gz"
curl -fsSL -o "$work/$tarball" \
  "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F$RCODESIGN_VERSION/$tarball"
echo "$sum  $work/$tarball" | sha256sum -c --quiet -
tar -xzf "$work/$tarball" -C "$work"
rcodesign="$work/apple-codesign-$RCODESIGN_VERSION-$triple/rcodesign"

(
  umask 077
  printf '%s' "$MACOS_DEVELOPER_ID_P12" | base64 -d > "$work/developer-id.p12"
  printf '%s' "$MACOS_DEVELOPER_ID_P12_PASSWORD" > "$work/p12.password"
  printf '%s' "$ASC_API_KEY_JSON" > "$work/asc-api-key.json"
)

for bin in "${BINARIES[@]}"; do
  echo "==> Signing $bin"
  "$rcodesign" sign --for-notarization \
    --p12-file "$work/developer-id.p12" --p12-password-file "$work/p12.password" \
    --binary-identifier com.reoclo.cli \
    --entitlements-xml-file packaging/macos/entitlements.plist \
    "$bin"
  "$rcodesign" verify "$bin"
done

echo "==> Notarizing"
python3 -m zipfile -c "$work/reoclo-macos.zip" "${BINARIES[@]}"
"$rcodesign" notary-submit --api-key-file "$work/asc-api-key.json" \
  --wait --max-wait-seconds 2700 "$work/reoclo-macos.zip"
echo "==> Signed and notarized: ${BINARIES[*]}"
