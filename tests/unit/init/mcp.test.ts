import { describe, expect, test } from "bun:test";
import { mergeMcpServer, REOCLO_MCP_SERVER } from "../../../src/init/mcp";

describe("mergeMcpServer", () => {
  test("creates the structure from empty config", () => {
    expect(mergeMcpServer(null)).toEqual({ mcpServers: { reoclo: REOCLO_MCP_SERVER } });
  });

  test("creates the structure from an empty object", () => {
    expect(mergeMcpServer({})).toEqual({ mcpServers: { reoclo: REOCLO_MCP_SERVER } });
  });

  test("preserves other servers when adding reoclo", () => {
    const existing = { mcpServers: { other: { command: "x", args: ["y"] } } };
    expect(mergeMcpServer(existing)).toEqual({
      mcpServers: {
        other: { command: "x", args: ["y"] },
        reoclo: REOCLO_MCP_SERVER,
      },
    });
  });

  test("updates an existing reoclo entry without dropping others", () => {
    const existing = {
      mcpServers: { reoclo: { command: "old" }, other: { command: "x" } },
    };
    expect(mergeMcpServer(existing)).toEqual({
      mcpServers: { reoclo: REOCLO_MCP_SERVER, other: { command: "x" } },
    });
  });

  test("preserves unrelated top-level keys", () => {
    const existing = { $schema: "https://example/schema.json", mcpServers: {} };
    const merged = mergeMcpServer(existing) as Record<string, unknown>;
    expect(merged.$schema).toBe("https://example/schema.json");
    expect(merged.mcpServers).toEqual({ reoclo: REOCLO_MCP_SERVER });
  });

  test("recovers when mcpServers is not an object", () => {
    expect(mergeMcpServer({ mcpServers: "broken" })).toEqual({
      mcpServers: { reoclo: REOCLO_MCP_SERVER },
    });
  });
});
