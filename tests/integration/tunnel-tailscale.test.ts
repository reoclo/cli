// The Tailscale transport and tailnet shares through the real daemon: a control
// socket, a saved-tunnels file, a fake gateway and a fake Tailscale CLI. A
// local listener stands in for the server's port on the tailnet, and a fake
// process stands in for each `tailscale serve` child. Nothing runs the real CLI,
// touches a tailnet, or listens on a fixed port.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeafIssuer } from "../../src/tunnels/ca";
import { emptyConfig, loadConfig, saveConfig } from "../../src/tunnels/config";
import { ControlClient } from "../../src/tunnels/control-client";
import { startDaemon, type DaemonHandle } from "../../src/tunnels/daemon";
import { HostsError, type HostsSink } from "../../src/tunnels/hosts-client";
import { tunnelsFile } from "../../src/tunnels/paths";
import { Tailscale } from "../../src/tunnels/tailscale";
import { FakeDirectory } from "../helpers/fake-directory";
import { Changes, FakeSpawner, FakeTailscaleRunner, STOPPED_STATUS, TAILNET, fakeTailscale, statusJson } from "../helpers/fake-tailscale";
import { freePort, startFakeWsGateway, type FakeWsGateway } from "../helpers/fake-ws-gateway";
import { rejectionOf } from "../helpers/rejection";
import { seedTenantProfile } from "../helpers/seed-profile";

const TENANT_ID = "00000000-0000-0000-0000-00000000aaaa";
const SERVER_ID = "00000000-0000-0000-0000-00000000bbbb";

const noHelper: HostsSink = {
  status: () => Promise.reject(new HostsError("not_installed", "the hosts helper is not installed")),
  set: () => Promise.reject(new HostsError("not_installed", "the hosts helper is not installed")),
};

let tmp: string;
let gw: FakeWsGateway | undefined;
let daemon: DaemonHandle | undefined;
let runner: FakeTailscaleRunner;
let spawner: FakeSpawner;
let directory: FakeDirectory;
let changes: Changes;
let cleanup: Array<() => Promise<void>>;
let saved: Record<string, string | undefined>;

function setEnv(key: string, value: string): void {
  if (!(key in saved)) saved[key] = process.env[key];
  process.env[key] = value;
}

beforeEach(async () => {
  saved = {};
  cleanup = [];
  tmp = mkdtempSync(join(tmpdir(), "rt-tailscale-"));
  setEnv("REOCLO_CONFIG_DIR", tmp);
  setEnv("REOCLO_CACHE_DIR", join(tmp, "cache"));
  seedTenantProfile({ configDir: tmp, apiUrl: "http://127.0.0.1:1", token: "rk_t_daemon", tenantId: TENANT_ID });
  saveConfig({ ...emptyConfig(), idle_timeout_seconds: 0.3, https_port: await freePort() }, tunnelsFile());
  runner = new FakeTailscaleRunner();
  spawner = new FakeSpawner();
  directory = new FakeDirectory();
  changes = new Changes();
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await gw?.stop();
  gw = undefined;
  for (const fn of cleanup) await fn();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function boot(o: { gateway?: { echo?: boolean; http?: boolean }; tailscale?: Tailscale } = {}): Promise<ControlClient> {
  gw = await startFakeWsGateway(o.gateway ?? { echo: true });
  daemon = await startDaemon({
    directUrl: gw.url,
    log: () => undefined,
    certs: new LeafIssuer(),
    hosts: noHelper,
    directory,
    tailscale: o.tailscale ?? fakeTailscale(runner),
    spawnShare: spawner.spawn,
  });
  daemon.manager.onEvent(() => changes.notify());
  return new ControlClient(daemon.socketPath);
}

async function peerService(): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on("error", () => undefined);
    s.once("close", () => sockets.delete(s));
    s.pipe(s);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  );
  return (server.address() as net.AddressInfo).port;
}

const base = { org: "acme", tenant_id: TENANT_ID, profile: "default", server: "prod-1", server_id: SERVER_ID, server_hostname: "prod-1" };

function echo(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    let got = "";
    s.once("error", reject);
    s.once("connect", () => s.write(payload));
    s.on("data", (b) => {
      got += b.toString();
      if (got.length >= payload.length) {
        s.destroy();
        resolve(got);
      }
    });
    s.once("close", () => resolve(got));
  });
}

const tailnetWithPeer = (): string => statusJson({ peers: [{ host: "prod-1", ips: ["127.0.0.1"] }] });

describe("the daemon's Tailscale status", () => {
  it("reports a running node, with the tailnet name and certificate state", async () => {
    const client = await boot();
    expect((await client.status()).tailscale).toEqual({ installed: true, running: true, state: "Running", tailnet: TAILNET, https_certificates: true });
  });

  it("reports an installed app that is stopped", async () => {
    runner.status = STOPPED_STATUS;
    const client = await boot();
    expect((await client.status()).tailscale).toMatchObject({ installed: true, running: false, state: "Stopped", https_certificates: false });
  });

  it("reports Tailscale as not installed without running anything", async () => {
    const client = await boot({ tailscale: new Tailscale({ runner: runner.runner, find: () => undefined }) });
    expect((await client.status()).tailscale).toMatchObject({ installed: false, running: false });
    expect(runner.calls).toEqual([]);
  });
});

describe("the tailnet transport", () => {
  it("carries a tcp tunnel to the peer without opening a gateway session", async () => {
    runner.status = tailnetWithPeer();
    const client = await boot();
    const peerPort = await peerService();
    const local = await freePort();
    await client.add({ ...base, name: "db", kind: "tcp", target: `127.0.0.1:${peerPort}`, local_port: local, via: "tailscale" });
    expect(await echo(local, "over the tailnet")).toBe("over the tailnet");
    expect(gw?.connections).toBe(0);
    expect(gw?.frames).toEqual([]);
    expect(await client.tunnel("db")).toMatchObject({ via: "tailscale", path: "tailscale", peer: { name: "prod-1", online: true } });
  });

  it("reads the port scan through the directory and refuses a loopback-only port", async () => {
    runner.status = tailnetWithPeer();
    const client = await boot();
    const local = await freePort();
    await client.add({ ...base, name: "db", kind: "tcp", target: "127.0.0.1:5432", local_port: local, via: "tailscale" });
    await changes.until(() => daemon?.manager.get("db").state === "failed", "the tunnel to be refused");
    expect((await client.tunnel("db")).detail).toContain("listens only on 127.0.0.1");
    expect(directory.calls).toContain(`ports acme ${SERVER_ID}`);
    expect(gw?.connections).toBe(0);
  });

  it("sends an auto tunnel through the relay when the scan says the tailnet cannot reach the port", async () => {
    runner.status = tailnetWithPeer();
    const client = await boot();
    const local = await freePort();
    await client.add({ ...base, name: "db", kind: "tcp", target: "127.0.0.1:5432", local_port: local, via: "auto" });
    expect(await echo(local, "via the relay")).toBe("via the relay");
    expect(gw?.frames.find((f) => f["type"] === "tunnel_open")).toMatchObject({ host: "127.0.0.1", port: 5432 });
    expect(await client.tunnel("db")).toMatchObject({ path: "relay", via: "auto" });
    expect((await client.tunnel("db")).path_reason).toContain("listens only on");
  });

  it("uses the relay for an auto tunnel while Tailscale is stopped, and the tailnet once it runs", async () => {
    runner.status = STOPPED_STATUS;
    const client = await boot();
    const peerPort = await peerService();
    const local = await freePort();
    await client.add({ ...base, name: "db", kind: "tcp", target: `127.0.0.1:${peerPort}`, local_port: local, via: "auto" });
    expect(await echo(local, "one")).toBe("one");
    expect(gw?.connections).toBe(1);
    runner.status = tailnetWithPeer();
    expect(await echo(local, "two")).toBe("two");
    expect((await client.tunnel("db")).path).toBe("tailscale");
    expect(gw?.frames.filter((f) => f["type"] === "tunnel_open")).toHaveLength(1);
  });
});

describe("sharing onto the tailnet", () => {
  async function shareTcp(client: ControlClient): Promise<void> {
    await client.add({ ...base, name: "db", kind: "tcp", target: "127.0.0.1:5432", local_port: await freePort() });
  }

  it("runs a foreground tailscale serve for a tcp tunnel and ends it with unshare", async () => {
    const client = await boot();
    await shareTcp(client);
    const local = (await client.tunnel("db")).local_port;
    const view = await client.share("db", { tailnet: true });
    expect(view.share).toMatchObject({ tailnet: true, port: 5432 });
    await changes.until(() => spawner.procs.length === 1, "the share child to start");
    expect(spawner.procs[0]?.args).toEqual(["serve", "--tcp=5432", `tcp://127.0.0.1:${local}`]);
    expect(spawner.procs[0]?.args).not.toContain("--bg");

    spawner.procs[0]?.say("Available within your tailnet:\n");
    await changes.until(() => daemon?.manager.get("db").share?.state === "active", "the share to be active");
    expect((await client.tunnel("db")).share?.url).toBe(`tcp://laptop.${TAILNET}:5432`);
    expect(loadConfig(tunnelsFile()).tunnels[0]).toMatchObject({ share: { tailnet: true, port: 5432 } });

    const after = await client.unshare("db");
    expect(after.share).toBeUndefined();
    expect(spawner.procs[0]?.killed).toEqual(["SIGTERM"]);
  });

  it("serves an https tunnel through a plaintext loopback listener on a port saved in the config", async () => {
    const client = await boot({ gateway: { http: true } });
    await client.add({
      ...base,
      name: "grafana",
      kind: "https",
      target: "127.0.0.1:3000",
      hostname: "grafana.prod-1.reoclo.localhost",
      share: { tailnet: true },
    });
    const share = loadConfig(tunnelsFile()).tunnels[0];
    const internal = share?.kind === "https" ? share.share?.internal_port : undefined;
    expect(typeof internal).toBe("number");
    expect(share).toMatchObject({ share: { tailnet: true, port: 443 } });
    await changes.until(() => spawner.procs.length === 1, "the share child to start");
    expect(spawner.procs[0]?.args).toEqual(["serve", "--https=443", `http://127.0.0.1:${internal}`]);

    const reply = await new Promise<string>((resolve, reject) => {
      const s = net.connect(internal as number, "127.0.0.1");
      let got = "";
      s.once("error", reject);
      s.once("connect", () => s.write("GET /tailnet HTTP/1.1\r\nHost: grafana\r\n\r\n"));
      s.on("data", (b) => {
        got += b.toString();
        if (got.includes("fake gateway saw")) {
          s.destroy();
          resolve(got);
        }
      });
    });
    expect(reply).toContain("fake gateway saw: GET /tailnet HTTP/1.1");
    expect(await client.status()).toMatchObject({ tunnels: { total: 1 } });
  });

  it("shows a taken internal port as a failed share and leaves the tunnel up", async () => {
    const taken = net.createServer();
    await new Promise<void>((r) => taken.listen(0, "127.0.0.1", () => r()));
    cleanup.push(() => new Promise<void>((r) => taken.close(() => r())));
    const port = (taken.address() as net.AddressInfo).port;
    const client = await boot();
    const view = await client.add({
      ...base,
      name: "grafana",
      kind: "https",
      target: "127.0.0.1:3000",
      hostname: "grafana.prod-1.reoclo.localhost",
      share: { tailnet: true, port: 443, internal_port: port },
    });
    expect(view.state).toBe("ready");
    expect(view.share).toMatchObject({ state: "failed" });
    expect(view.share?.error).toContain(`internal port ${port} is already in use`);
    expect(spawner.procs).toHaveLength(0);
  });

  it("holds an agent's request to share or unshare for a person, and keeps closing ungated", async () => {
    const client = await boot();
    await shareTcp(client);
    const agent = new ControlClient(daemon?.socketPath, { client: "mcp", agent: "test-agent" });

    const ask = await agent.requestWithStatus<{ id: string; action: string; description: string }>("POST", "/v1/tunnels/db/share", { tailnet: true });
    expect(ask.status).toBe(202);
    expect(ask.body).toMatchObject({ action: "share_tunnel", description: 'Share "db" to prod-1 on the tailnet' });
    expect(spawner.procs).toHaveLength(0);
    expect((await client.tunnel("db")).share).toBeUndefined();

    await client.approve(ask.body.id);
    await changes.until(() => spawner.procs.length === 1, "the approved share to start");

    const stop = await agent.requestWithStatus<{ id: string; action: string }>("DELETE", "/v1/tunnels/db/share");
    expect(stop.status).toBe(202);
    expect(stop.body.action).toBe("unshare_tunnel");
    expect(spawner.procs[0]?.killed).toEqual([]);
    await client.approve(stop.body.id);
    expect(spawner.procs[0]?.killed).toEqual(["SIGTERM"]);

    await client.share("db", { tailnet: true });
    await changes.until(() => spawner.procs.length === 2, "the share to start again");
    expect((await agent.down("db")).state).toBe("down");
    expect(spawner.procs[1]?.killed).toEqual(["SIGTERM"]);
  });

  it("lets an agent share without approval when agent approvals are off", async () => {
    const client = await boot();
    await shareTcp(client);
    await client.updateSettings({ agent_approvals: "off" });
    const agent = new ControlClient(daemon?.socketPath, { client: "mcp", agent: "test-agent" });
    const reply = await agent.requestWithStatus("POST", "/v1/tunnels/db/share", { tailnet: true });
    expect(reply.status).toBe(200);
    await changes.until(() => spawner.procs.length === 1, "the share to start");
  });

  it("rejects what cannot be shared, with the daemon's message", async () => {
    const client = await boot();
    await shareTcp(client);
    expect(await rejectionOf(client.share("db", {} as { tailnet: true }))).toMatchObject({ code: "invalid", status: 400 });
    expect(await rejectionOf(client.share("ghost", { tailnet: true }))).toMatchObject({ code: "not_found", status: 404 });
  });

  it("stops every share when the daemon stops", async () => {
    const client = await boot();
    await shareTcp(client);
    await client.share("db", { tailnet: true });
    await changes.until(() => spawner.procs.length === 1, "the share child to start");
    await daemon?.stop();
    daemon = undefined;
    expect(spawner.procs[0]?.killed).toEqual(["SIGTERM"]);
  });
});
