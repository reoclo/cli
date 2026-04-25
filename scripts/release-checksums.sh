#!/usr/bin/env bash
# scripts/release-checksums.sh
# Generates SHA256SUMS for all binaries in dist/.
set -euo pipefail
cd dist
shasum -a 256 reoclo-* > SHA256SUMS
echo "==> SHA256SUMS:"
cat SHA256SUMS
