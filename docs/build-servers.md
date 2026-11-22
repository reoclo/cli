# Build on dedicated build servers

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
