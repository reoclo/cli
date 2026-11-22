# Reoclo CLI

Command-line interface for [Reoclo](https://reoclo.com). Manage servers, applications, deployments, logs, domains and tunnels from your terminal.

## Install

```bash
brew install reoclo/tap/reoclo
```

Or, without Homebrew:

```bash
curl -sSL https://get.reoclo.com/cli | bash
```

npm and manual downloads are covered in [Install](docs/install.md), which also explains self-update and macOS signing. From 0.120.0 the macOS binaries are signed with the Developer ID of BOXMARSHALL LTD and notarized by Apple.

## Quick start

```bash
# Sign in (opens your browser via OAuth device flow)
reoclo login

# Confirm
reoclo whoami

# List your servers
reoclo servers ls

# Tail logs for an application
reoclo logs tail my-app

# Open a forward tunnel: localhost:5432 → 127.0.0.1:5432 on the runner
reoclo tunnel my-server -L 5432:5432

# Open a reverse tunnel: server's localhost:8080 → localhost:3000 on your machine
reoclo tunnel my-server -R 8080:3000
```

`reoclo --help` lists every command, and `reoclo <command> --help` explains one.

## Documentation

| Guide | What it covers |
|-------|----------------|
| [Install](docs/install.md) | Homebrew, the installer, npm and manual downloads, with macOS signing and self-update |
| [Commands, output and profiles](docs/commands.md) | The command list, command aliases, output formats for scripts and named profiles |
| [Apps and deploys](docs/apps-and-deploys.md) | Apps and secret projects, `reoclo up`, git submodules and cancelling a deployment |
| [Secrets](docs/secrets.md) | Bitwarden and 1Password sync, and detaching or deleting synced secrets |
| [Monitors and traffic](docs/monitoring.md) | Monitors and deploy health checks, and request traffic per app or domain |
| [Build servers](docs/build-servers.md) | Build pools on your own servers or on ephemeral Hetzner builders, with their costs |
| [Test servers](docs/test-servers.md) | Test pools and running your repository's tests, by hand or from CI |
| [Tunnels](docs/tunnels.md) | Forward and reverse tunnels, and how they recover and are limited |
| [DNS records](docs/dns.md) | Adding and removing records on connected Cloudflare zones |
| [MCP for coding agents](docs/mcp.md) | Registering the Reoclo MCP server with Claude Code and Codex |
| [Development](docs/development.md) | Building from source and running the tests, and how releases are signed |

The full command reference and guides are also at <https://docs.reoclo.com/cli>.

## Reporting issues

Issues and feature requests: <https://github.com/reoclo/cli/issues>

## License

MIT. See [LICENSE](./LICENSE).
