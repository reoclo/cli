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
  up                      deploy a linked repository (creates its stack or app on the first run)
  repos                   mirrored git repositories: scan, link, list
  stacks                  definition groups: create and deploy compose stacks
  build-pools             manage build pools (groups of build servers)
  builds                  build history on build servers
  test-pools              manage test pools (machines that run your test files)
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
  mcp                     run as a Model Context Protocol server
  completion              generate shell completion scripts
```

Every `ls` subcommand also answers to `list`, and every `rm` also answers to
`delete` and `remove`, so `reoclo servers list` and `reoclo servers ls` are the
same command.

## Install

**One-liner (macOS / Linux):**

```bash
curl -sSL https://get.reoclo.com/cli | bash
```

The installer detects your platform, downloads the latest release from GitHub, verifies the SHA256 checksum, and installs to `/usr/local/bin/reoclo` (or `~/.local/bin/reoclo` if the system dir isn't writable). It also creates `rc` as a short alias for `reoclo`.

Equivalent direct URL (handy in environments where the redirect isn't followed):

```bash
curl -sSL https://github.com/reoclo/cli/releases/latest/download/install.sh | bash
```

### Manual install

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

### Self-update

```bash
reoclo upgrade          # in-place update to the latest stable
reoclo upgrade --check  # report current + latest without changing anything
```

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

## Create apps and secret projects, publish DNS, reconcile the proxy

```bash
# Secret project, then an app that binds it (--bind is repeatable)
reoclo secrets projects create staging-secrets --description "Staging stack"
reoclo apps create --name stack --server web1 --repo acme/web \
  --compose-file deploy/compose.staging.yml --compose-service web \
  --deploy-branch staging --require-ci --bind staging-secrets

# Deploy a branch or commit once, without changing the app's deploy branch
reoclo apps deploy stack --ref feat/login

# Enable DNS publishing, plan the records, publish them (exits 1 if blocked)
reoclo domains publish app.example.com --proxied

# Re-sync a server's managed proxy now
reoclo proxy reconcile web1

# Restrict who can reach a server's domains by source IP (managed proxy only)
reoclo proxy allowlist web1 --cloudflare --allow 203.0.113.0/24
reoclo domains access app.example.com --inherit
```

## Secrets from Bitwarden and 1Password, and safe deletes

`secrets ls` shows where each secret comes from and whether it is in sync. `--source` filters by origin (`manual`, `bitwarden`, `onepassword`). With `-o json` the rows are the API's, filtered but otherwise unchanged.

```bash
reoclo secrets ls --project prod
# KEY          VERSION  SOURCE    SYNC    LAST SYNCED
# DB_PASSWORD  3        bitwarden synced  2026-11-01T09:12:44Z
# SENTRY_DSN   1        manual    -       -
reoclo secrets ls --project prod --source bitwarden

# Who reads this secret? Applications and stacks, by env reference or project binding
reoclo secrets usage DB_PASSWORD --project prod

# Synced secrets whose Bitwarden or 1Password connection was removed (add --project to narrow)
reoclo secrets orphans
reoclo secrets orphans --project prod -o json

# Stop syncing one secret; the value stays in Reoclo and becomes a manual secret
reoclo secrets detach DB_PASSWORD --project prod

# Detach every secret from one source (--all needs --source)
reoclo secrets detach --all --source bitwarden --project prod --yes
```

`secrets detach` asks before it changes anything (`--yes` skips the prompt) and reports how many secrets it detached. A manual secret is already detached, so the command says so and makes no API call.

`secrets orphans` lists synced secrets that lost their connection. Removing a connection in the dashboard detaches its secrets by default, so orphans only appear when someone chose to keep them as they were. They stay read-only until you detach them.

`secrets rm` lists the applications and stacks that use the secret and asks you to confirm. A synced secret cannot be deleted until it is detached: pass `--detach` to detach and delete in one step, or run `secrets detach` first. When the secret's connection is still syncing, `secrets rm` also prints a warning from the API: the connection would overwrite an edited copy or bring a deleted one back, so detach it (which also stops the sync recreating it).

```bash
reoclo secrets rm DB_PASSWORD --project prod --detach
```

Every command that deletes something asks first and takes `--yes` to skip the prompt: `monitors rm`, `secrets rm`, `channels delete`, `schedule rm`, `providers rm`, `env rm`, `status-pages rm` and `profile rm`, alongside the ones that already did. Without a terminal and without `--yes` a delete aborts with exit code 1 instead of waiting for input.

## Monitors and health checks

Creating a monitor for a URL that already has one fails and points at the existing monitor. A paused monitor is resumed instead of recreated.

```bash
reoclo monitors create --name api --url https://api.example.com
# Error: A monitor for this URL already exists: api (paused, id 5f1c...)
#   It is paused. Resume it with `reoclo monitors resume 5f1c...`
```

`apps config set --health-check` sets the deploy health check. The spec is `http:/path`, `tcp`, `command:<cmd>` or `none`. It goes through the same merge and PATCH as the other `apps config set` flags, so the rest of the config is kept.

```bash
reoclo apps config set web --health-check http:/healthz
reoclo apps config set web --health-check tcp
reoclo apps config set web --health-check none
```

## Request traffic

`reoclo traffic` reads the request metrics the managed proxy records for one application or domain. Name exactly one with `--app <id|name>` or `--domain <fqdn|id>`. `--range` takes `15m`, `1h` (default), `6h`, `24h`, `7d`, `30d` or `90d`. `-o json` prints the API body unchanged.

```bash
# Requests, errors, latency and bytes, each with the change against the previous period
reoclo traffic summary --app web --range 24h

# One route only (--route and --method go together)
reoclo traffic summary --domain app.example.com --route /users/:id --method GET

# The busiest routes; sort by requests, errors, p95 or bytes
reoclo traffic routes --app web --sort p95 --limit 20

# Redraw the last 15 minutes every 5 seconds; Ctrl-C stops it
reoclo traffic watch --domain app.example.com --interval 5
```

The same data is available to agents through the `get_traffic_summary` and `list_traffic_routes` MCP tools.

## Git submodules on deploy

Deploys do not check out git submodules unless you ask. `--submodules` takes `off` (the default, and what a missing value means), `on` (top-level submodules) or `recursive` (submodules of submodules). Any other value exits 2 and lists the three.

```bash
# Turn it on for an app, or for a stack (a stack is a definition group)
reoclo apps config set web --submodules recursive
reoclo stacks config set my-stack --submodules on

# Set it when creating, before the first deploy
reoclo apps create --name web --server web1 --repo acme/web --submodules on --deploy
reoclo stacks create --repo acme/web --server web1 --submodules recursive --deploy

# Back to the default
reoclo apps config set web --submodules off
```

`apps get`, `apps config get` and `stacks get` show the current value as `submodules`, `off` when the API returns none. The mode is saved with a PATCH of the application or the stack, apart from the build and deploy config, so `apps config set web --submodules on` alone does not touch the rest of the config. On create, the application or stack is created first and the mode set right after; if that second request fails, the error says what was created and which `config set` command finishes the job. `stacks config set` needs at least one field, so it exits 4 with `no fields to update` when `--submodules` is missing.

## Deploy a linked repository

`reoclo up` deploys a repository that is linked to Reoclo. Run it in a checkout (it reads the `origin` remote) or pass `--repo owner/name`. It finds the stack or application that already deploys the repository and deploys it. On the first run it creates one, so `--server` is needed once. A repository with a compose file becomes a stack; a repository with a single Dockerfile becomes an application (`--service` picks one when there are several).

It waits for the deployment by default and exits 1 if the deployment fails, or 12 if `--wait-timeout` (default 600 seconds) runs out first. `--no-wait` returns right after the deployment is triggered.

```bash
# First run in a project folder: creates the stack or app on web1, then deploys it
reoclo up --server web1

# Every later run deploys what the first run created
reoclo up

# Another repository, branch and compose file; recreate containers even if nothing changed
reoclo up --repo acme/web --branch staging --compose-file deploy/compose.staging.yml --force-recreate
```

The pieces `up` is built from are available on their own:

```bash
# Make a connected provider mirror a repository (GitHub selection or Gitea sync), then wait for it
reoclo repos link acme/web
reoclo repos link acme/web --no-wait

# Show what a repository can deploy at a ref: compose files, services, ports, images
reoclo repos scan acme/web --ref staging
reoclo repos scan acme/web --config deploy/compose.prod.yml

# One stack per compose file, the same as the dashboard's deploy as stack
reoclo stacks create --repo acme/web --server web1 --compose-file deploy/compose.yml --deploy --wait

# Create an application and deploy it in one step
reoclo apps create --name web --server web1 --repo acme/web --deploy --wait --ref main
```

`repos link` needs an organization admin. Stacks need the definition groups feature to be on for your organization; the API's message is shown when it is not.

## Stop a running deployment

Cancelling asks the API to stop the deployment. If it had not started, or its worker is gone, it is cancelled at once. Otherwise the step that is running is stopped (on an SSH server, once it ends), except the step that replaces running services, which finishes first; the status stays as it was until then. A deployment that already finished answers 409 and the command exits 1.

```bash
# A stack's newest run that is still running; or pick one by its number (the N column) or ID
reoclo groups cancel my-stack
reoclo groups cancel my-stack 12

# One app deployment by ID (--app only checks that it belongs to that app)
reoclo deployments cancel <deployment-id>
reoclo deployments cancel <deployment-id> --app web

# Print the API answer: id, status, cancel_requested_at, message
reoclo -o json groups cancel my-stack 12
```

## Build on dedicated build servers

A server's role says what it is for: `runtime` (the default), `build`, or `both`.
Build servers join a pool, and an app builds on a pool instead of its own server.
A pool-built image is pushed to a registry, so the app needs a push target.

```bash
# Make a server a builder and group it into a pool (--server is repeatable)
reoclo servers set-role build1 build
reoclo build-pools create --name builders --server build1 --max-concurrent 2

# A registry credential that may push, limited to one repository prefix
reoclo registry create --name ghcr-push --type private --url https://ghcr.io \
  --username bot --push --repository-prefix ghcr.io/acme/ --password-stdin

# Build an app on the pool and push the image to that registry
reoclo apps config set stack --build-placement pool:<pool-id> \
  --push-credential <credential-id> --push-repository ghcr.io/acme/stack
# Back to building on the app's own server
reoclo apps config set stack --build-placement target

# Watch and stop builds (--status filters the fetched page)
reoclo builds ls --app stack --status building
reoclo builds logs <build-id>
reoclo builds cancel <build-id>

reoclo build-pools ls
reoclo build-pools set builders --max-concurrent 4
reoclo build-pools rm builders --yes
```

An ephemeral pool creates a Hetzner server for a build and deletes it afterwards. It needs an organization Hetzner credential and a monthly net budget. New builders stop when the budget is reached.

```bash
# Price a builder before creating the pool (server plus IPv4, net and gross)
reoclo build-pools estimate --cloud-credential hetzner-main --location fsn1 --server-type cx33

reoclo build-pools create --name burst --mode ephemeral --cloud-credential hetzner-main \
  --location fsn1 --server-type cx33 --fallback-type cpx22 --budget 25
# Idle builders go near the end of the billed hour by default; or immediate, or ttl:<minutes>
reoclo build-pools set burst --idle-policy ttl:15 --max-lifetime 90 --budget 40

# Month to date, forecast and budget usage; the builders and what they cost so far
reoclo build-pools costs burst
reoclo build-pools builders burst

# Compare a monthly Hetzner consumption statement with the estimates (admins only)
reoclo build-pools reconcile --file statement.csv --cloud-credential hetzner-main --month 2026-09
```

`reoclo exec` waits for the command to finish: `--timeout <seconds>` (default 600) is both the command timeout and the basis for how long the CLI waits for the answer.

## Run tests on test servers

Test servers run the tests declared in your repository (`ci/reoclo/tests/<name>.yml`) on machines Reoclo creates in your own AWS or Hetzner account. They are enabled per organization.

```bash
# A pool: where and how machines are created (--secret values are write-only)
reoclo test-pools create --name CI --credential hetzner-main --location fsn1 --server-type cx33 \
  --max-machines 4 --budget 25 --var NODE_ENV=test --secret API_TOKEN=...
reoclo test-pools ls
reoclo test-pools machines ci

# Turn tests on for a repository (organization admins; it asks first, --yes skips the question)
reoclo tests enable --repo acme/web

# Write a starter file in this repository, check it against the API, then run it
reoclo tests init unit --pool ci
reoclo tests validate
reoclo tests ls --repo acme/web --refresh
reoclo tests run unit --repo acme/web --ref main --wait

# Past runs: a run is its id or its number
reoclo tests runs --test unit --state failed
reoclo tests show 12
reoclo tests logs 12 --job build --follow
reoclo tests cancel 12
reoclo tests rerun 12
```

`--repo` takes `owner/name` or an id, and defaults to the git `origin` remote of the current checkout.

`tests run --wait` follows the run, prints each job and step as it changes with the job logs, and exits `0` when the run passes, `1` when it fails and `2` when it errors or is cancelled, so a pipeline can gate on it. Ctrl+C asks whether to cancel the run; answering no stops waiting and leaves it running (exit `130`). In CI use a machine token, because automation keys cannot call these routes.

```yaml
# GitHub Actions
- run: reoclo tests run unit --repo acme/web --ref "$GITHUB_REF_NAME" --wait
  env:
    REOCLO_MACHINE_TOKEN: ${{ secrets.REOCLO_MACHINE_TOKEN }}
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

Tunnels survive transient runner reconnects: if the runner disconnects briefly, the CLI parks the session and resumes once the runner is back. If the CLI itself loses its connection, it reconnects with backoff and gives up after `--reconnect-deadline` seconds (default 300).

Large transfers are fine. The CLI sends stream data in frames of at most 64 KiB, so a big upload through a tunnel no longer closes the connection.

### Concurrent tunnel limit

Each user and each organization can hold a limited number of open tunnels at once. When you hit the limit, the tunnel exits instead of retrying, with a message such as:

```
tunnel: max concurrent tunnels per user reached (4). Run `reoclo tunnel ls` to see open tunnels and `reoclo tunnel close <id>` to free one.
```

(The defaults are 4 per user and 32 per organization. The number in the message is your current limit, and the organization form reads "per tenant".) Run `reoclo tunnel ls --active` to see what is open, then `reoclo tunnel close <tunnel-id>` to free a slot.

### Closing stale sessions

`reoclo tunnel close` also cleans up a session that no gateway holds any more, for example after a crash. The command reports that the session "had no live connection" and marks it closed. If the session was seen on a gateway within the last few minutes it is left open and the command asks you to try again shortly.

## DNS records on managed zones

On Cloudflare zones your organization has connected, you can add, list and remove TXT, CNAME and MX records without opening the Cloudflare dashboard. Reoclo finds the zone from the record name; records Reoclo publishes for your apps cannot be changed here.

```bash
# DMARC policy for example.com
reoclo dns records add _dmarc.example.com --type TXT --content "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"

reoclo dns records ls example.com --type TXT
reoclo dns records rm <record-id> --zone example.com
```

`rm` asks before deleting; `--yes` skips the prompt.

## Output formats

Most commands honour `-o text|json|yaml`. Pipe `json` into `jq` for scripting, or `yaml` for human-readable nested output.

Two things to know when scripting:

- **List commands emit one JSON object per line (NDJSON), not a JSON array.** Filter each line directly — `jq -r '.field'` — not `jq '.[]'`, which yields nothing.
- **`secrets get` always prints the bare secret value** with no formatting (so it composes with `$(...)` and pipes); it does not honour `-o`.

```bash
reoclo servers ls -o json | jq -r 'select(.status == "active") | .name'
reoclo apps ls -o yaml
VALUE=$(reoclo secrets get DB_PASSWORD --project prod)   # the raw value, not JSON
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
