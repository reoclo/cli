// src/init/mcp.ts
//
// Pure merge for `reoclo init --mcp`: register the reoclo CLI as a Claude Code
// MCP server in the project's `.mcp.json` WITHOUT clobbering any servers (or
// unrelated top-level keys) the user already has. The CLI is itself a stdio MCP
// server via `reoclo mcp`.

export const REOCLO_MCP_SERVER = { command: "reoclo", args: ["mcp"] };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Return a new `.mcp.json` object with the reoclo server added/updated under
 * `mcpServers`, preserving every other server and top-level key. Recovers
 * gracefully when the input (or its `mcpServers`) is missing or malformed.
 */
export function mergeMcpServer(existing: unknown): unknown {
  const root = asRecord(existing);
  const servers = asRecord(root.mcpServers);
  return {
    ...root,
    mcpServers: { ...servers, reoclo: REOCLO_MCP_SERVER },
  };
}
