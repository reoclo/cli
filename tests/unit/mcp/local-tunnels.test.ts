// The local tunnel tools through a real MCP client, a real control server and a
// real TunnelManager with a fake pool. The 60-second approval wait is cut short
// by an injected AbortSignal instead of a timer.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient } from "../../../src/client/http";
import { createMcpServer } from "../../../src/mcp/server";
import { registerLocalTunnelTools, shapeTunnel, type LocalTunnelDeps } from "../../../src/mcp/local/tunnels";
import { ControlClient, DaemonError } from "../../../src/tunnels/control-client";
import { startControlServer, type ControlServer } from "../../../src/tunnels/control-server";
import { TunnelManager, type TunnelView } from "../../../src/tunnels/manager";
import { PoolError } from "../../../src/tunnels/pool";
import { subscribe } from "../../helpers/events";
import { FakeDirectory } from "../../helpers/fake-directory";
import { FakePool } from "../../helpers/fake-pool";
import { freePort } from "../../helpers/fake-ws-gateway";

const SERVER_ID = "00000000-0000-0000-0000-00000000bbbb";
const TOOLS = ["close_tunnel", "list_local_tunnels", "open_tunnel", "save_tunnel", "tunnel_status"];

let dir: string;
let socket: string;
let manager: TunnelManager;
let control: ControlServer;
let pool: FakePool;
let directory: FakeDirectory;
let cli: ControlClient;
let waitFor: AbortController;
let mcp: Client;
let ids: number;
const saved: Record<string, string | undefined> = {};

const apiClient = {
  get: (path: string) =>
    Promise.resolve(
      path.endsWith("/servers/")
        ? [{ id: SERVER_ID, slug: "prod-1", name: "Production", hostname: "prod-1.example.com", connection_type: "runner", status: "online" }]
        : {},
    ),
} as unknown as HttpClient;

function deps(extra: Partial<LocalTunnelDeps> = {}): LocalTunnelDeps {
  return {
    ctx: { client: apiClient, orgParam: {}, resolveOrg: () => Promise.resolve({ tenantId: "t1", client: apiClient }) },
    org: "acme",
    profile: "default",
    connect: (identity) => Promise.resolve(new ControlClient(socket, identity)),
    waitSignal: () => waitFor.signal,
    caPath: () => undefined,
    ...extra,
  };
}

async function connectTools(extra: Partial<LocalTunnelDeps> = {}): Promise<Client> {
  const server = new McpServer({ name: "reoclo", version: "0" });
  registerLocalTunnelTools(server, deps(extra));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent-x", version: "1.2.3" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

interface Called {
  isError: boolean;
  body: Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown> = {}, client: Client = mcp): Promise<Called> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text: string }>).map((c) => c.text).join("");
  return { isError: res.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rt-mcp-"));
  socket = join(dir, "run", "tunneld.sock");
  for (const key of ["REOCLO_CACHE_DIR"]) saved[key] = process.env[key];
  process.env["REOCLO_CACHE_DIR"] = join(dir, "cache");
  pool = new FakePool();
  directory = new FakeDirectory();
  ids = 0;
  waitFor = new AbortController();
  manager = new TunnelManager({ configPath: join(dir, "tunnels.yaml"), createPool: () => pool });
  control = startControlServer({
    socketPath: socket,
    manager,
    version: "9.9.9",
    startedAt: Date.now(),
    stateDir: dir,
    log: () => undefined,
    onShutdown: () => undefined,
    directory,
    approvals: { newId: () => `ap${++ids}` },
  });
  cli = new ControlClient(socket);
  mcp = await connectTools();
});
afterEach(async () => {
  await mcp.close();
  await control.stop();
  await manager.stop();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const base = { org: "acme", tenant_id: "t1", server: "prod-1", server_id: "s1" };
const forward = async (name: string, extra: Record<string, unknown> = {}) => ({
  ...base,
  name,
  kind: "tcp",
  target: "127.0.0.1:5432",
  local_port: await freePort(),
  ...extra,
});
const reverse = (name = "hook", extra: Record<string, unknown> = {}) => ({
  ...base,
  name,
  kind: "reverse",
  remote_port: 8080,
  local_target: "127.0.0.1:3000",
  ...extra,
});

describe("registration", () => {
  it("offers the five tunnel tools", async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(20);
  });

  it("adds nothing to the tool catalog the hosted MCP vendors", async () => {
    const server = createMcpServer({ client: apiClient, orgParam: {}, resolveOrg: () => Promise.reject(new Error("unused")) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "catalog", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    for (const tool of TOOLS) expect(names).not.toContain(tool);

    const toolsDir = join(import.meta.dir, "..", "..", "..", "src", "mcp", "tools");
    for (const file of readdirSync(toolsDir).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(toolsDir, file), "utf8");
      for (const tool of TOOLS) expect(text).not.toContain(`"${tool}"`);
    }
  });
});

describe("list_local_tunnels and tunnel_status", () => {
  it("shows saved tunnels with their endpoint and no expiry", async () => {
    const created = await cli.add(await forward("db"));
    const { body } = await call("list_local_tunnels");
    const [t] = body["tunnels"] as Array<Record<string, unknown>>;
    expect(t).toMatchObject({ name: "db", kind: "tcp", state: "ready", ad_hoc: false, expires_at: null, endpoint: created.endpoint, via: "reoclo", path: "relay" });
    expect(t).not.toHaveProperty("share");
  });

  it("shows ad-hoc tunnels with their expiry", async () => {
    await call("open_tunnel", { server: "prod-1", target: "5432" });
    const { body } = await call("list_local_tunnels");
    const [t] = body["tunnels"] as Array<Record<string, unknown>>;
    expect(t).toMatchObject({ ad_hoc: true });
    expect(typeof t?.["expires_at"]).toBe("string");
  });

  it("reports one tunnel, and an error for one that does not exist", async () => {
    await cli.add(await forward("db"));
    expect((await call("tunnel_status", { name: "db" })).body).toMatchObject({ name: "db", state: "ready", traffic: { streams: 0 } });
    const missing = await call("tunnel_status", { name: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.body).toMatchObject({ code: "not_found" });
  });
});

describe("open_tunnel", () => {
  it("opens an ad-hoc tunnel for a server and a target", async () => {
    const { isError, body } = await call("open_tunnel", { server: "prod-1", target: "5432", ttl_minutes: 15 });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ kind: "tcp", ad_hoc: true, target: "127.0.0.1:5432" });
    expect(body["endpoint"]).toBe(`http://${String(body["address"])}`);
    expect(String(body["address"])).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(Date.parse(String(body["expires_at"])) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(directory.calls).toEqual(["resolve acme prod-1"]);
    expect(pool.acquired).toEqual(["stream"]);
  });

  it("opens a udp tunnel on a udp address", async () => {
    const { body } = await call("open_tunnel", { server: "prod-1", target: "127.0.0.1:53", kind: "udp" });
    expect(String(body["endpoint"])).toMatch(/^udp:\/\/127\.0\.0\.1:\d+$/);
  });

  it("brings up a saved tunnel by name and checks the connection", async () => {
    await cli.add(await forward("db", { enabled: false }));
    const { body } = await call("open_tunnel", { name: "db" });
    expect(body).toMatchObject({ name: "db", state: "ready" });
    expect(pool.acquired).toEqual(["stream"]);
  });

  it("needs an organization for an ad-hoc tunnel", async () => {
    const client = await connectTools({ org: undefined });
    const { isError, body } = await call("open_tunnel", { server: "prod-1", target: "5432" }, client);
    expect(isError).toBe(true);
    expect(String(body["error"])).toContain("organization");
    await client.close();
  });

  it("refuses an ambiguous or empty request", async () => {
    expect((await call("open_tunnel", { name: "db", server: "prod-1", target: "5432" })).isError).toBe(true);
    expect((await call("open_tunnel", {})).isError).toBe(true);
    expect((await call("open_tunnel", { server: "prod-1" })).isError).toBe(true);
  });

  it("tells the agent to ask for a sign-in when the session cannot open", async () => {
    pool.error = new PoolError("needs_sign_in", "sign-in expired");
    const { isError, body } = await call("open_tunnel", { server: "prod-1", target: "5432" });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ code: "unauthorized", state: "needs_sign_in" });
    expect(String(body["hint"])).toContain("reoclo login");
    expect((await call("list_local_tunnels")).body["tunnels"]).toEqual([]);
  });

  it("tells the agent when the daemon cannot be reached", async () => {
    const client = await connectTools({ connect: () => Promise.reject(new DaemonError("unreachable", "could not reach the tunnel daemon")) });
    const { isError, body } = await call("list_local_tunnels", {}, client);
    expect(isError).toBe(true);
    expect(String(body["hint"])).toContain("reoclo tunnel daemon start");
    await client.close();
  });

  it("names the agent in the approval, and returns the result when a person approves", async () => {
    await cli.add(reverse("hook", { enabled: false }));
    const arrived = await subscribe(socket, '"status":"pending"');
    const opening = call("open_tunnel", { name: "hook" });
    await arrived.text;
    expect(await cli.approvals()).toMatchObject([{ id: "ap1", agent: "agent-x", action: "open_tunnel" }]);
    await cli.approve("ap1");
    const { isError, body } = await opening;
    expect(isError).toBe(false);
    expect(body).toMatchObject({ name: "hook", kind: "reverse", state: "ready" });
    expect((await cli.tunnel("hook")).enabled).toBe(true);
  });

  it("returns pending_approval when nobody answers in time", async () => {
    await cli.add(reverse("hook", { enabled: false }));
    const arrived = await subscribe(socket, '"status":"pending"');
    const opening = call("open_tunnel", { name: "hook" });
    await arrived.text;
    waitFor.abort();
    const { isError, body } = await opening;
    expect(isError).toBe(false);
    expect(body).toMatchObject({ status: "pending_approval", id: "ap1", action: "open_tunnel" });
    expect(String(body["message"])).toContain("reoclo tunnel approve ap1");
    expect((await cli.approvals()).map((a) => a.status)).toEqual(["pending"]);
    expect((await cli.tunnel("hook")).enabled).toBe(false);
  });

  it("reports a denial", async () => {
    await cli.add(reverse("hook", { enabled: false }));
    const arrived = await subscribe(socket, '"status":"pending"');
    const opening = call("open_tunnel", { name: "hook" });
    await arrived.text;
    await cli.deny("ap1");
    const { isError, body } = await opening;
    expect(isError).toBe(true);
    expect(body).toMatchObject({ status: "denied", id: "ap1" });
  });

  it("reports an approved request that then failed", async () => {
    await cli.add(reverse("hook", { enabled: false }));
    const arrived = await subscribe(socket, '"status":"pending"');
    const opening = call("open_tunnel", { name: "hook" });
    await arrived.text;
    await cli.remove("hook");
    await cli.approve("ap1");
    const { isError, body } = await opening;
    expect(isError).toBe(true);
    expect(body).toMatchObject({ status: "approved_but_failed", code: "not_found" });
  });
});

describe("close_tunnel", () => {
  it("ends an ad-hoc tunnel", async () => {
    const opened = await call("open_tunnel", { server: "prod-1", target: "5432" });
    const { body } = await call("close_tunnel", { name: String(opened.body["name"]) });
    expect(body).toMatchObject({ closed: true, ad_hoc: true, state: "down" });
    expect((await call("list_local_tunnels")).body["tunnels"]).toEqual([]);
  });

  it("brings a saved tunnel down and keeps it saved", async () => {
    await cli.add(await forward("db"));
    expect((await call("close_tunnel", { name: "db" })).body).toMatchObject({ closed: true, ad_hoc: false, state: "down" });
    expect((await cli.tunnel("db")).enabled).toBe(false);
  });

  it("closes a reverse tunnel without asking", async () => {
    await cli.add(reverse());
    expect((await call("close_tunnel", { name: "hook" })).isError).toBe(false);
    expect(await cli.approvals(true)).toEqual([]);
  });
});

describe("save_tunnel", () => {
  it("saves a plain tcp tunnel with the server's display name", async () => {
    const { isError, body } = await call("save_tunnel", { name: "db", server: "prod-1", target: "5432", local_port: await freePort() });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ name: "db", kind: "tcp", server: "Production", target: "127.0.0.1:5432" });
    expect((await cli.tunnel("db")).server_id).toBe(SERVER_ID);
  });

  it("changes a saved tunnel when the name exists", async () => {
    await call("save_tunnel", { name: "db", server: "prod-1", target: "5432", local_port: await freePort() });
    const { isError, body } = await call("save_tunnel", { name: "db", server: "prod-1", target: "10.0.0.5:5432" });
    expect(isError).toBe(false);
    expect(body["target"]).toBe("10.0.0.5:5432");
    expect((await cli.tunnels()).map((t) => t.name)).toEqual(["db"]);
  });

  it("holds a reverse tunnel for approval, then saves it", async () => {
    const arrived = await subscribe(socket, '"status":"pending"');
    const saving = call("save_tunnel", { name: "hook", server: "prod-1", kind: "reverse", remote_port: 8080, local_target: "3000" });
    await arrived.text;
    expect(await cli.tunnels()).toEqual([]);
    await cli.approve("ap1");
    const { isError, body } = await saving;
    expect(isError).toBe(false);
    expect(body).toMatchObject({ name: "hook", kind: "reverse", remote_port: 8080, local_target: "127.0.0.1:3000" });
  });

  it("returns pending_approval for a hostname when nobody answers", async () => {
    const arrived = await subscribe(socket, '"status":"pending"');
    const saving = call("save_tunnel", { name: "db", server: "prod-1", target: "5432", hostname: "db.prod-1.reoclo.localhost" });
    await arrived.text;
    waitFor.abort();
    const { body } = await saving;
    expect(body).toMatchObject({ status: "pending_approval", action: "save_tunnel" });
    expect(await cli.tunnels()).toEqual([]);
  });

  it("explains a flag mix that makes no sense", async () => {
    const { isError, body } = await call("save_tunnel", { name: "hook", server: "prod-1", kind: "reverse", remote_port: 8080 });
    expect(isError).toBe(true);
    expect(String(body["error"])).toContain("local-target");
  });

  it("needs an organization", async () => {
    const client = await connectTools({ org: undefined });
    expect((await call("save_tunnel", { name: "db", server: "prod-1", target: "5432" }, client)).isError).toBe(true);
    await client.close();
  });
});

describe("shapeTunnel", () => {
  const view = (extra: Partial<TunnelView>): TunnelView => ({
    name: "grafana",
    org: "acme",
    server: "prod-1",
    server_id: "s1",
    kind: "https",
    keep_up: false,
    enabled: true,
    via: "reoclo",
    path: "relay",
    state: "active",
    message: "Session open",
    action: "None",
    url: "https://grafana.prod-1.reoclo.localhost:8443",
    hostname: "grafana.prod-1.reoclo.localhost",
    traffic: { bytes_in: 1, bytes_out: 2, streams: 1 },
    ...extra,
  });

  it("gives an https tunnel its URL and the CA path", () => {
    expect(shapeTunnel(view({}), "/home/u/ca.pem")).toMatchObject({
      endpoint: "https://grafana.prod-1.reoclo.localhost:8443",
      ca_path: "/home/u/ca.pem",
    });
  });

  it("leaves out the CA path when there is none, or for a tunnel that is not https", () => {
    expect(shapeTunnel(view({}))).not.toHaveProperty("ca_path");
    expect(shapeTunnel(view({ kind: "tcp", endpoint: "127.0.0.1:15432", url: undefined }), "/x/ca.pem")).not.toHaveProperty("ca_path");
  });

  it("shows the transport path, the tailnet peer and a share", () => {
    const shaped = shapeTunnel(
      view({
        kind: "tcp",
        url: undefined,
        endpoint: "127.0.0.1:15432",
        via: "auto",
        path: "relay",
        path_reason: "prod-1 is offline on the tailnet",
        peer: { name: "prod-1", online: false },
        share: { tailnet: true, port: 5432, state: "active", url: "tcp://box.example-tailnet.ts.net:5432", restarts: 2 },
      }),
    );
    expect(shaped).toMatchObject({
      via: "auto",
      path: "relay",
      path_reason: "prod-1 is offline on the tailnet",
      tailnet_peer: { name: "prod-1", online: false },
      share: { state: "active", port: 5432, url: "tcp://box.example-tailnet.ts.net:5432" },
    });
    expect((shaped["share"] as Record<string, unknown>)["error"]).toBeUndefined();
  });

  it("leaves out the path reason, peer and share when there are none", () => {
    const shaped = shapeTunnel(view({}));
    for (const key of ["path_reason", "tailnet_peer", "share"]) expect(shaped).not.toHaveProperty(key);
    expect(shaped).toMatchObject({ via: "reoclo", path: "relay" });
  });

  it("includes the suggested action and detail only when there is something to do", () => {
    const failing = shapeTunnel(view({ state: "needs_sign_in", action: "Run reoclo login", detail: "expired" }));
    expect(failing).toMatchObject({ action: "Run reoclo login", detail: "expired" });
    expect(shapeTunnel(view({}))).not.toHaveProperty("action");
  });
});
