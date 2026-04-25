# @reoclo/theta (compatibility shim)

As of v2.0.0, `@reoclo/theta` is a thin shim that downloads the `reoclo` CLI
binary and runs `reoclo mcp`. The previous theta-mcp implementation has been
folded into the unified [`@reoclo/cli`](https://www.npmjs.com/package/@reoclo/cli)
package.

## What changed

The MCP tool surface (servers, applications, deployments, domains, logs,
monitors, status pages, scheduled operations) now lives in `@reoclo/cli`'s
`reoclo mcp` subcommand. Same tools, same behavior — different binary.

## Existing configs keep working

Any MCP client config like:

```json
{
  "command": "npx",
  "args": ["-y", "@reoclo/theta"],
  "env": { "REOCLO_API_KEY": "rk_t_..." }
}
```

continues to work unchanged. On first invocation, this shim downloads the
`reoclo` binary into `~/.cache/reoclo/bin/` and execs `reoclo mcp`.

## Recommended canonical install

Going forward, install the CLI directly and point your MCP client at the
canonical command:

```bash
brew install reoclo/tap/reoclo
# or:
curl -sSL https://get.reoclo.com/cli | bash
```

```json
{
  "command": "reoclo",
  "args": ["mcp"],
  "env": { "REOCLO_API_KEY": "rk_t_..." }
}
```

The shim will continue to be published for back-compat through Q3 2026.
