# Development

## Building from source

Requires [Bun](https://bun.sh) 1.3+.

```bash
git clone https://github.com/reoclo/cli.git
cd cli
bun install
bun run build           # produces dist/reoclo-{platform}
```

Run tests and typecheck:

```bash
bun test tests/unit/
bun run typecheck
```

A local build leaves the macOS binaries signed ad hoc. Releases are built on Woodpecker when a `vX.Y.Z` tag is pushed: the tag pipeline signs and notarizes the macOS binaries with `scripts/sign-macos.sh` before it writes `SHA256SUMS`, then publishes the GitHub release and the Homebrew formula. npm publishes from the GitHub release.
