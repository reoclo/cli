// tests/integration/mcp.test.ts
import { expect, test, beforeEach, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { $ } from "bun";
import type { FakeGateway } from "../helpers/fake-gateway";
import { startFakeGateway } from "../helpers/fake-gateway";

let tmp: string;
let gw: FakeGateway;

beforeEach(async () => {
  gw = startFakeGateway();
  tmp = mkdtempSync(join(tmpdir(), "reoclo-mcp-"));
  // Login so the profile has tenant_id (tools register only when tenantId is set)
  await $`bun run src/index.ts login --token ${gw.token} --api ${gw.url} --no-keyring`.env({
    ...process.env,
    REOCLO_CONFIG_DIR: tmp,
    REOCLO_CACHE_DIR: join(tmp, "cache"),
  }).quiet();
});

afterEach(() => {
  gw.stop();
});

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

async function sendRpc(
  proc: ChildProcess,
  request: object,
): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString();
      // MCP framing: each message is a single JSON object on its own line
      const newlineIdx = buf.indexOf("\n");
      if (newlineIdx >= 0) {
        const line = buf.slice(0, newlineIdx);
        buf = buf.slice(newlineIdx + 1);
        proc.stdout?.off("data", onData);
        try {
          resolve(JSON.parse(line) as JsonRpcResponse);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    };
    proc.stdout?.on("data", onData);
    proc.stdin?.write(JSON.stringify(request) + "\n");
    setTimeout(() => {
      proc.stdout?.off("data", onData);
      reject(new Error(`RPC timeout waiting for ${(request as { method?: string }).method}`));
    }, 5000);
  });
}

test("mcp server responds to initialize and tools/list", async () => {
  const env = {
    ...process.env,
    REOCLO_CONFIG_DIR: tmp,
    REOCLO_CACHE_DIR: join(tmp, "cache"),
  };

  const proc = spawn("bun", ["run", "src/index.ts", "mcp"], {
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });

  // Wait for MCP server to be ready
  await new Promise((r) => setTimeout(r, 500));

  try {
    // initialize
    const initResp = await sendRpc(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    expect(initResp.id).toBe(1);
    expect(initResp.result).toBeDefined();
    const initResult = initResp.result as { serverInfo: { name: string } };
    expect(initResult.serverInfo.name).toBe("reoclo");

    // tools/list
    const listResp = await sendRpc(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(listResp.id).toBe(2);
    expect(listResp.result).toBeDefined();
    const listResult = listResp.result as { tools: Array<{ name: string }> };
    expect(Array.isArray(listResult.tools)).toBe(true);
    expect(listResult.tools.length).toBeGreaterThan(10);

    // Confirm a known tool name is present
    const toolNames = listResult.tools.map((t) => t.name);
    expect(toolNames).toContain("list_servers");
  } finally {
    proc.kill();
  }
});
