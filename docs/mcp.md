# Register the MCP server with coding agents

`reoclo mcp install` adds the Reoclo MCP server to the coding agents on this Mac, so you do not edit their config files by hand. It supports Claude Code (`~/.claude.json`) and Codex (`~/.codex/config.toml`, or `$CODEX_HOME/config.toml`).

```bash
reoclo mcp agents                          # agents found here and whether reoclo is registered (-o json for scripts)
reoclo mcp install --agent claude-code     # or codex, or all for every agent found
reoclo mcp install --agent all --command ~/.local/bin/reoclo
reoclo mcp uninstall --agent all           # removes only the reoclo entry
```

The agent runs `<command> mcp` over stdio. `<command>` is the absolute path you ran `reoclo` by, not the symlink target, so `~/.local/bin/reoclo` stays valid when the app moves or updates. `--command` overrides it. This is what each install writes:

```json
"mcpServers": { "reoclo": { "type": "stdio", "command": "<command>", "args": ["mcp"] } }
```

```toml
[mcp_servers.reoclo]
command = "<command>"
args = ["mcp"]
```

Install is idempotent and updates an existing `reoclo` entry in place. Everything else in the file, comments included, stays byte for byte, each file is replaced atomically, and the first change keeps a copy next to it as `<file>.reoclo-backup`. A config that cannot be parsed or written is reported and never overwritten. The entry has no `--org`, so the server starts unbound and every tool takes an organization.
