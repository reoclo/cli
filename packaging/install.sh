#!/usr/bin/env bash
# packaging/install.sh
# Install the Reoclo CLI:  curl -sSL https://get.reoclo.com/cli | bash
set -euo pipefail

VERSION="${REOCLO_VERSION:-latest}"
CHANNEL="${REOCLO_CHANNEL:-stable}"
INSTALL_DIR_FLAG=""
NO_MODIFY_PATH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)        CHANNEL="$2"; shift 2;;
    --version)        VERSION="$2"; shift 2;;
    --install-dir)    INSTALL_DIR_FLAG="$2"; shift 2;;
    --no-modify-path) NO_MODIFY_PATH=1; shift;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done

case "$(uname -s | tr '[:upper:]' '[:lower:]')" in
  linux)  OS=linux ;;
  darwin) OS=darwin ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64)  ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

TARGET="${OS}-${ARCH}"

if [[ "$VERSION" == "latest" ]]; then
  VERSION=$(curl -sSf "https://get.reoclo.com/cli/${CHANNEL}")
fi

URL="https://github.com/reoclo/cli/releases/download/${VERSION}/reoclo-${TARGET}"
SUMS_URL="https://github.com/reoclo/cli/releases/download/${VERSION}/SHA256SUMS"

# Resolve install dir
if [[ -n "$INSTALL_DIR_FLAG" ]]; then
  INSTALL_DIR="$INSTALL_DIR_FLAG"
  mkdir -p "$INSTALL_DIR"
elif [[ -w /usr/local/bin ]]; then
  INSTALL_DIR=/usr/local/bin
else
  INSTALL_DIR="${HOME}/.local/bin"
  mkdir -p "$INSTALL_DIR"
fi

TMP=$(mktemp -d); trap "rm -rf $TMP" EXIT
echo "==> Downloading reoclo ${VERSION} (${TARGET})..."
curl -sSLf -o "${TMP}/reoclo" "$URL"
curl -sSLf -o "${TMP}/SHA256SUMS" "$SUMS_URL"
(cd "$TMP" && grep "reoclo-${TARGET}$" SHA256SUMS \
  | awk -v t="${TMP}/reoclo" '{print $1"  "t}' \
  | shasum -a 256 -c -)

chmod +x "${TMP}/reoclo"
mv "${TMP}/reoclo" "${INSTALL_DIR}/reoclo"

# Create the 'rc' short alias as a symlink. Idempotent: replaces an
# existing rc symlink/file in the same dir.
ln -sf reoclo "${INSTALL_DIR}/rc"

echo "✓ installed reoclo ${VERSION} to ${INSTALL_DIR}/reoclo"
echo "✓ symlinked rc -> reoclo at ${INSTALL_DIR}/rc"
if ! command -v reoclo >/dev/null && [[ "$NO_MODIFY_PATH" == "0" ]]; then
  echo ""
  echo "⚠ ${INSTALL_DIR} is not on your PATH."
  echo "  Add this to your shell rc:"
  echo "    export PATH=\"${INSTALL_DIR}:\$PATH\""
fi
echo "Run 'reoclo login' to authenticate."
