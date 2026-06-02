// src/commands/mcp.ts
import type { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootstrap } from "../client/bootstrap";
import { createMcpServer } from "../mcp/server";

export function registerMcp(program: Command): void {
  program
    .command("mcp")
    // No command-local `--profile` — the global flag is honored by bootstrap()
    // (which reads the captured global override, then $REOCLO_PROFILE, then the
    // active profile).
    .description("start the stdio MCP server")
    .action(async () => {
      const ctx = await bootstrap({ mcpSource: true });

      // stdout is sacred for MCP protocol framing — redirect any incidental
      // console.log to stderr while the server is running.
      const origLog = console.log;
      console.log = console.error;

      try {
        const server = createMcpServer({
          client: ctx.client,
          tenantId: ctx.tenantId,
        });
        await server.connect(new StdioServerTransport());
      } finally {
        console.log = origLog;
      }
    });
}
