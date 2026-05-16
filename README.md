# Reoclo CLI

Command-line interface for [Reoclo](https://reoclo.com) — manage servers, applications, deployments, logs, domains, and tunnels from your terminal.

```
$ reoclo --help
Usage: reoclo [options] [command]

Reoclo CLI

Options:
  -V, --version           output the version number
  -o, --output <fmt>      output format: text|json|yaml (default: "text")
  --no-color              disable ANSI colors
  --quiet                 suppress non-error output
  --verbose               log HTTP requests (tokens redacted)
  -h, --help              display help for command

Commands:
  login                   sign in with your Reoclo account
  whoami                  show the current identity
  servers                 manage servers
  apps                    manage applications
  deployments             deployment history
  logs                    tail or query application logs
  env                     application environment variables
  domains                 manage domains
  exec                    run a command on a server
  shell                   open an interactive shell on a server
  tunnel                  forward / reverse TCP and UDP tunnels
  profile                 manage named profiles
  keyring                 OS keyring management
  upgrade                 self-update the CLI
  mcp                     run as a Model Context Protocol server
  completion              generate shell completion scripts
```

## Install

Download the binary for your platform from the [latest release](https://github.com/reoclo/cli/releases/latest):

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

Each release includes a `SHA256SUMS` file you can verify against:

```bash
curl -L -o SHA256SUMS https://github.com/reoclo/cli/releases/latest/download/SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing
```

Once installed, `reoclo upgrade` performs an in-place self-update.

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

## Tunnels

The `tunnel` command opens authenticated TCP and UDP tunnels through a server's runner. No SSH keys, no inbound firewall rules — the tunnel rides the runner's existing outbound WebSocket connection.

```bash
# Forward TCP (default)
reoclo tunnel <server> -L 5432:5432
reoclo tunnel <server> -L 8080:internal-db:5432       # remote host other than localhost
reoclo tunnel <server> -L 0.0.0.0:8080:internal:80    # bind explicitly

# Forward UDP
reoclo tunnel <server> -L 53:53 --udp

# Reverse TCP
reoclo tunnel <server> -R 8080:3000

# Multiple forwards in one session
reoclo tunnel <server> -L 5432:5432 -L 6379:6379

# Session management (live + history)
reoclo tunnel ls --server <server> --active
reoclo tunnel describe <tunnel-id>
reoclo tunnel close <tunnel-id>
```

Tunnels survive transient runner reconnects: if the runner disconnects briefly, the CLI parks the session and resumes once the runner is back.

## Output formats

Every command honours `-o text|json|yaml`. Pipe `json` into `jq` for scripting, or `yaml` for human-readable nested output:

```bash
reoclo servers ls -o json | jq '.[] | select(.status=="active") | .name'
reoclo apps ls -o yaml
```

## Profiles

The CLI supports multiple named profiles — useful if you work across organizations or environments:

```bash
reoclo profile ls
reoclo --profile staging login
reoclo --profile staging servers ls
```

Profile data is stored under the OS-appropriate config dir (e.g. `~/.config/reoclo/` on Linux, `~/Library/Application Support/reoclo/` on macOS). Tokens are kept in the OS keyring when available; run `reoclo keyring status` to inspect.

## Documentation

Full command reference and guides: <https://docs.reoclo.com/cli>

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

## Reporting issues

Issues and feature requests: <https://github.com/reoclo/cli/issues>

## License

MIT — see [LICENSE](./LICENSE).
