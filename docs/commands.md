# Commands, output and profiles

## Commands

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
  up                      deploy a linked repository (creates its stack or app on the first run)
  repos                   mirrored git repositories: scan, link, list
  stacks                  definition groups: create and deploy compose stacks
  build-pools             manage build pools (groups of build servers)
  builds                  build history on build servers
  test-pools              manage test pools (machines that run your test files)
  storage-credentials     manage the storage keys test pools use for caches and artifacts
  tests                   test files and test runs on test servers
  deployments             deployment history
  logs                    tail or query application logs
  traffic                 request traffic for an application or domain
  env                     application environment variables
  domains                 manage domains
  verified-domains        manage verified root domains (proof of ownership)
  status-pages            manage status pages
  exec                    run a command on a server
  proxy                   manage a server's managed proxy
  shell                   open an interactive shell on a server
  tunnel                  forward / reverse TCP and UDP tunnels
  profile                 manage named profiles
  keyring                 OS keyring management
  upgrade                 self-update the CLI
  mcp                     run as a Model Context Protocol server, or register it with coding agents
  completion              generate shell completion scripts
```

Every `ls` subcommand also answers to `list`, and every `rm` also answers to
`delete` and `remove`, so `reoclo servers list` and `reoclo servers ls` are the
same command.

## Output formats

Most commands honour `-o text|json|yaml`. Pipe `json` into `jq` for scripting, or `yaml` for human-readable nested output.

Two things to know when scripting:

- **List commands emit one JSON object per line (NDJSON), not a JSON array.** Filter each line directly with `jq -r '.field'`, not with `jq '.[]'`, which yields nothing.
- **`secrets get` always prints the bare secret value** with no formatting (so it composes with `$(...)` and pipes); it does not honour `-o`.

```bash
reoclo servers ls -o json | jq -r 'select(.status == "active") | .name'
reoclo apps ls -o yaml
VALUE=$(reoclo secrets get DB_PASSWORD --project prod)   # the raw value, not JSON
```

## Profiles

The CLI supports multiple named profiles, which helps when you work across organizations or environments:

```bash
reoclo profile ls
reoclo --profile staging login
reoclo --profile staging servers ls
```

Profile data is stored under the OS-appropriate config dir (e.g. `~/.config/reoclo/` on Linux, `~/Library/Application Support/reoclo/` on macOS). Tokens are kept in the OS keyring when available; run `reoclo keyring status` to inspect.
