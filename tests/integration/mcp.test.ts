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

    // Confirm runtime tools are registered
    expect(toolNames).toContain("list_tenant_containers");
    expect(toolNames).toContain("recreate_container");
    expect(toolNames).toContain("scale_container");
    expect(toolNames).toContain("update_container_labels");

    // SP3-B tunnel tools
    expect(toolNames).toContain("list_tunnel_sessions");
    expect(toolNames).toContain("get_tunnel_session");

    // SP3-B repository tools
    expect(toolNames).toContain("get_repository");
    expect(toolNames).toContain("list_repo_branches");
  } finally {
    proc.kill();
  }
});

test("list_tunnel_sessions returns sessions for the active organization", async () => {
  const env = { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
  const proc = spawn("bun", ["run", "src/index.ts", "mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
  await new Promise((r) => setTimeout(r, 500));
  try {
    await sendRpc(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    const resp = await sendRpc(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_tunnel_sessions", arguments: {} },
    });
    expect(resp.result).toBeDefined();
    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]?.text).toBeDefined();
    const parsed: unknown = JSON.parse(result.content[0]?.text ?? "[]");
    expect(Array.isArray(parsed) || (typeof parsed === "object" && parsed !== null)).toBe(true);
  } finally {
    proc.kill();
  }
});

test("get_tunnel_session with unknown id surfaces an error", async () => {
  const env = { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
  const proc = spawn("bun", ["run", "src/index.ts", "mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
  await new Promise((r) => setTimeout(r, 500));
  try {
    await sendRpc(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    const resp = await sendRpc(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_tunnel_session", arguments: { tunnel_id: "does-not-exist" } },
    });
    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
  } finally {
    proc.kill();
  }
});

test("get_repository returns a repository record", async () => {
  const env = { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
  const proc = spawn("bun", ["run", "src/index.ts", "mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
  await new Promise((r) => setTimeout(r, 500));
  try {
    await sendRpc(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    // Seeded repository id from SP1-C fake-gateway fixture.
    const repoId = "11111111-1111-1111-1111-111111111111";
    const resp = await sendRpc(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_repository", arguments: { repository_id: repoId } },
    });
    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content[0]?.text ?? "{}") as { full_name?: string };
    expect(parsed.full_name).toBeDefined();
  } finally {
    proc.kill();
  }
});

test("list_repo_branches returns branches with default marker", async () => {
  const env = { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
  const proc = spawn("bun", ["run", "src/index.ts", "mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
  await new Promise((r) => setTimeout(r, 500));
  try {
    await sendRpc(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    const repoId = "11111111-1111-1111-1111-111111111111";
    const resp = await sendRpc(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_repo_branches", arguments: { repository_id: repoId } },
    });
    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content[0]?.text ?? "[]") as Array<{ name: string; is_default: boolean }>;
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.some((b) => b.is_default === true)).toBe(true);
  } finally {
    proc.kill();
  }
});
