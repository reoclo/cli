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

GH_REPO="reoclo/cli"

if [[ "$VERSION" == "latest" ]]; then
  if [[ "$CHANNEL" != "stable" ]]; then
    echo "install.sh only supports --channel stable for auto-resolve." >&2
    echo "Install stable first, then switch channels with:" >&2
    echo "  reoclo upgrade --channel ${CHANNEL}" >&2
    exit 2
  fi
  # Query the GitHub Releases API directly. The /releases/latest endpoint
  # excludes prereleases by GitHub's contract, which is the desired
  # "stable" channel semantic. tag_name appears once in this single-object
  # response, so a grep+sed extraction is sufficient (no jq dependency).
  VERSION=$(curl -fsSL -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${GH_REPO}/releases/latest" \
    | grep -E '"tag_name":' | head -1 \
    | sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/')
  if [[ -z "$VERSION" ]]; then
    echo "failed to resolve latest version from GitHub Releases API" >&2
    exit 1
  fi
fi

URL="https://github.com/${GH_REPO}/releases/download/${VERSION}/reoclo-${TARGET}"
SUMS_URL="https://github.com/${GH_REPO}/releases/download/${VERSION}/SHA256SUMS"

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
echo "==> Downloading reoclo ${VERSION} (${TARGET})"
# Interactive progress bar on the binary fetch when stdout is a TTY;
# fall back to silent mode for pipes/CI logs.
if [[ -t 1 ]]; then
  CURL_PROGRESS="--progress-bar"
else
  CURL_PROGRESS="-sS"
fi
curl -fL $CURL_PROGRESS -o "${TMP}/reoclo" "$URL"
curl -sSLf -o "${TMP}/SHA256SUMS" "$SUMS_URL"
echo "==> Verifying checksum..."
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
