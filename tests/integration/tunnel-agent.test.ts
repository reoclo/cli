// An agent drives the tunnel daemon through the local MCP tools, against the
// fake gateway WebSocket: an ad-hoc forward tunnel carries data and closes at its
// time to live, and a reverse tunnel waits for a person before it registers.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient } from "../../src/client/http";
import { registerLocalTunnelTools } from "../../src/mcp/local/tunnels";
import { emptyConfig, loadConfig, saveConfig } from "../../src/tunnels/config";
import { ControlClient } from "../../src/tunnels/control-client";
import { startDaemon, type DaemonHandle } from "../../src/tunnels/daemon";
import type { TunnelState } from "../../src/tunnels/states";
import { subscribe } from "../helpers/events";
import { FakeDirectory } from "../helpers/fake-directory";
import { ManualTimers } from "../helpers/fake-pool";
import { startFakeWsGateway, type FakeWsGateway } from "../helpers/fake-ws-gateway";
import { seedTenantProfile } from "../helpers/seed-profile";

const TENANT_ID = "00000000-0000-0000-0000-00000000aaaa";
const SERVER_ID = "00000000-0000-0000-0000-00000000bbbb";

let tmp: string;
let gw: FakeWsGateway;
let daemon: DaemonHandle;
let timers: ManualTimers;
let cli: ControlClient;
let mcp: Client;
let waitFor: AbortController;
let saved: Record<string, string | undefined>;

function setEnv(key: string, value: string): void {
  if (!(key in saved)) saved[key] = process.env[key];
  process.env[key] = value;
}

beforeEach(async () => {
  saved = {};
  tmp = mkdtempSync(join(tmpdir(), "rt-agent-"));
  setEnv("REOCLO_CONFIG_DIR", tmp);
  setEnv("REOCLO_CACHE_DIR", join(tmp, "cache"));
  seedTenantProfile({ configDir: tmp, apiUrl: "http://127.0.0.1:1", token: "rk_t_agent", tenantId: TENANT_ID });
  saveConfig(emptyConfig(), join(tmp, "tunnels", "tunnels.yaml"));
  gw = await startFakeWsGateway({ echo: true });
  timers = new ManualTimers();
  const directory = new FakeDirectory();
  directory.serverId = SERVER_ID;
  daemon = await startDaemon({ directUrl: gw.url, log: () => undefined, directory, timers });
  cli = new ControlClient(daemon.socketPath);
  waitFor = new AbortController();

  const server = new McpServer({ name: "reoclo", version: "0" });
  registerLocalTunnelTools(server, {
    ctx: { client: {} as HttpClient, orgParam: {}, resolveOrg: () => Promise.reject(new Error("not used")) },
    org: "acme",
    profile: "default",
    connect: (identity) => Promise.resolve(new ControlClient(daemon.socketPath, identity)),
    waitSignal: () => waitFor.signal,
    caPath: () => undefined,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: "agent-x", version: "1" });
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
});

afterEach(async () => {
  await mcp.close();
  await daemon.stop();
  await gw.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const res = await mcp.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text: string }>).map((c) => c.text).join("");
  return { isError: res.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

function waitForState(name: string, state: TunnelState, timeoutMs = 5000): Promise<void> {
  const manager = daemon.manager;
  return new Promise((resolve, reject) => {
    const ok = (): boolean => manager.get(name).state === state;
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${name} to be ${state}; now ${manager.get(name).state}`));
    }, timeoutMs);
    const off = manager.onEvent(() => {
      if (!ok()) return;
      clearTimeout(timer);
      off();
      resolve();
    });
    if (ok()) {
      clearTimeout(timer);
      off();
      resolve();
    }
  });
}

function removed(name: string): Promise<void> {
  return new Promise((resolve) => {
    const off = daemon.manager.onEvent((e) => {
      if (e.type === "tunnel" && e.removed && e.name === name) {
        off();
        resolve();
      }
    });
  });
}

async function roundTrip(port: number, text: string): Promise<net.Socket> {
  const sock = net.connect(port, "127.0.0.1");
  const echoed = new Promise<string>((resolve, reject) => {
    sock.once("data", (b) => resolve(b.toString()));
    sock.once("error", reject);
    sock.once("close", () => reject(new Error("socket closed before the echo")));
  });
  sock.write(text);
  expect(await echoed).toBe(text);
  return sock;
}

function refused(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      reject(new Error(`port ${port} still accepts connections`));
    });
    s.once("error", () => resolve());
  });
}

describe("an agent with no person present", () => {
  it("opens a forward tunnel, uses it, and the daemon closes it at its time to live", async () => {
    const opened = await call("open_tunnel", { server: "prod-1", target: "127.0.0.1:5432", ttl_minutes: 5 });
    expect(opened.isError).toBe(false);
    const name = String(opened.body["name"]);
    const port = Number(String(opened.body["address"]).split(":")[1]);
    expect(opened.body).toMatchObject({ ad_hoc: true, kind: "tcp", state: "active" });
    expect(opened.body["endpoint"]).toBe(`http://127.0.0.1:${port}`);

    expect(gw.connections).toBe(1);
    expect(gw.urls[0]).toContain(`server_id=${SERVER_ID}`);
    const sock = await roundTrip(port, "from-the-agent");
    expect(gw.connections).toBe(1);
    const open = gw.frames.find((f) => f["type"] === "tunnel_open");
    expect([open?.["host"], open?.["port"]]).toEqual(["127.0.0.1", 5432]);
    sock.destroy();

    expect(loadConfig(join(tmp, "tunnels", "tunnels.yaml")).tunnels).toEqual([]);
    const listed = (await call("list_local_tunnels")).body["tunnels"] as Array<{ name: string }>;
    expect(listed.map((t) => t.name)).toEqual([name]);

    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([300_000]);
    const gone = removed(name);
    timers.fire();
    await gone;
    expect((await call("list_local_tunnels")).body["tunnels"]).toEqual([]);
    await refused(port);
  });

  it("closes an ad-hoc tunnel when the agent asks", async () => {
    const opened = await call("open_tunnel", { server: "prod-1", target: "5432" });
    const name = String(opened.body["name"]);
    const port = Number(String(opened.body["address"]).split(":")[1]);
    expect((await call("close_tunnel", { name })).body).toMatchObject({ closed: true, ad_hoc: true });
    await refused(port);
    expect(timers.pending.size).toBe(0);
  });
});

describe("a reverse tunnel an agent asks for", () => {
  const reverse = {
    name: "hook",
    org: "acme",
    tenant_id: TENANT_ID,
    server: "prod-1",
    server_id: SERVER_ID,
    kind: "reverse",
    remote_port: 8080,
    local_target: "127.0.0.1:3000",
    enabled: false,
  };

  it("waits for approval, then registers the listener on the gateway", async () => {
    await cli.add(reverse);
    const arrived = await subscribe(daemon.socketPath, '"status":"pending"');
    const opening = call("open_tunnel", { name: "hook" });
    await arrived.text;

    const [pending] = await cli.approvals();
    expect(pending).toMatchObject({ agent: "agent-x", action: "open_tunnel", status: "pending" });
    expect(gw.connections).toBe(0);
    expect(gw.frames.some((f) => f["type"] === "tunnel_listen_open")).toBe(false);

    await cli.approve(pending?.id ?? "");
    const { isError, body } = await opening;
    expect(isError).toBe(false);
    expect(body["name"]).toBe("hook");
    const listen = await gw.waitForFrame((f) => f["type"] === "tunnel_listen_open");
    expect(listen).toMatchObject({ port: 8080, bind: "127.0.0.1", proto: "tcp" });
    await waitForState("hook", "active");
  });

  it("reports pending_approval when nobody answers, and opens nothing", async () => {
    await cli.add(reverse);
    const arrived = await subscribe(daemon.socketPath, '"status":"pending"');
    const opening = call("open_tunnel", { name: "hook" });
    await arrived.text;
    waitFor.abort();
    const { body } = await opening;
    expect(body).toMatchObject({ status: "pending_approval", action: "open_tunnel" });
    expect(gw.connections).toBe(0);
    expect((await cli.tunnel("hook")).enabled).toBe(false);
    expect((await cli.approvals()).map((a) => a.status)).toEqual(["pending"]);
  });

  it("opens nothing when the person denies it", async () => {
    await cli.add(reverse);
    const arrived = await subscribe(daemon.socketPath, '"status":"pending"');
    const opening = call("open_tunnel", { name: "hook" });
    await arrived.text;
    const [pending] = await cli.approvals();
    await cli.deny(pending?.id ?? "");
    const { isError, body } = await opening;
    expect(isError).toBe(true);
    expect(body["status"]).toBe("denied");
    expect(gw.connections).toBe(0);
  });
});
