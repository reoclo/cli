// src/commands/mcp.ts
import type { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootstrap } from "../client/bootstrap";
import { createMcpServer } from "../mcp/server";

export function registerMcp(program: Command): void {
  program
    .command("mcp")
    .description("start the stdio MCP server (replaces @reoclo/theta)")
    .option("--profile <name>", "profile name")
    .action(async (opts: { profile?: string }) => {
      const ctx = await bootstrap({ profile: opts.profile });

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
