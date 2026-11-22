# Install

**One-liner (macOS / Linux):**

```bash
curl -sSL https://get.reoclo.com/cli | bash
```

The installer detects your platform, downloads the latest release from GitHub, verifies the SHA256 checksum, and installs to `/usr/local/bin/reoclo` (or `~/.local/bin/reoclo` if the system dir isn't writable). It also creates `rc` as a short alias for `reoclo`.

Equivalent direct URL (handy in environments where the redirect isn't followed):

```bash
curl -sSL https://github.com/reoclo/cli/releases/latest/download/install.sh | bash
```

**Homebrew (macOS / Linux):**

```bash
brew install reoclo/tap/reoclo
```

**npm:**

```bash
npm i -g @reoclo/cli
```

The npm package is a small shim that pulls in the binary for your platform, the same one the other channels install.

## Manual install

If you'd rather download the binary yourself, every release attaches a binary per platform plus a `SHA256SUMS` file. Pick the right one from [the latest release](https://github.com/reoclo/cli/releases/latest):

```bash
# macOS (Apple Silicon)
curl -L -o reoclo https://github.com/reoclo/cli/releases/latest/download/reoclo-darwin-arm64
chmod +x reoclo && sudo mv reoclo /usr/local/bin/

# macOS (Intel)
curl -L -o reoclo https://github.com/reoclo/cli/releases/latest/download/reoclo-darwin-x64
chmod +x reoclo && sudo mv reoclo /usr/local/bin/

# Linux (x86_64, glibc)
curl -L -o reoclo https://github.com/reoclo/cli/releases/latest/download/reoclo-linux-x64
chmod +x reoclo && sudo mv reoclo /usr/local/bin/

# Linux (x86_64, musl / Alpine)
curl -L -o reoclo https://github.com/reoclo/cli/releases/latest/download/reoclo-linux-x64-musl
chmod +x reoclo && sudo mv reoclo /usr/local/bin/

# Linux (arm64)
curl -L -o reoclo https://github.com/reoclo/cli/releases/latest/download/reoclo-linux-arm64
chmod +x reoclo && sudo mv reoclo /usr/local/bin/
```

**Windows (x86_64)**: download [`reoclo-windows-x64.exe`](https://github.com/reoclo/cli/releases/latest/download/reoclo-windows-x64.exe), rename to `reoclo.exe`, and add its directory to your `PATH`.

Verify against `SHA256SUMS`:

```bash
curl -L -o SHA256SUMS https://github.com/reoclo/cli/releases/latest/download/SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing
```

## macOS signing

From 0.120.0 the macOS binaries are signed with the Developer ID of BOXMARSHALL LTD and notarized by Apple, so macOS runs a binary you downloaded in a browser without a Gatekeeper prompt. Every channel above installs the same signed files. To check yours:

```bash
codesign -dvv "$(command -v reoclo)" 2>&1 | grep -E 'Authority=Developer ID Application|TeamIdentifier'
```

If macOS blocks an older binary you downloaded in a browser, run `reoclo upgrade`, or clear the quarantine flag once with `xattr -d com.apple.quarantine "$(command -v reoclo)"`.

## Self-update

```bash
reoclo upgrade          # in-place update to the latest stable
reoclo upgrade --check  # report current + latest without changing anything
```
