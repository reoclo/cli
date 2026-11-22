# Monitors and traffic

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
