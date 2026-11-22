# Apps and deploys

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
