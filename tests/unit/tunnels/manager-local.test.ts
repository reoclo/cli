import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { LeafIssuer, createCa } from "../../../src/tunnels/ca";
import { emptyConfig, saveConfig } from "../../../src/tunnels/config";
import { TunnelManager } from "../../../src/tunnels/manager";
import { freePort } from "../../helpers/fake-ws-gateway";
import { messageOf, rejectionOf } from "../../helpers/rejection";

const HOST = "app.reoclo.test";
const OTHER = "auth.reoclo.test";

let dir: string;
let configPath: string;
let httpsPort: number;
let manager: TunnelManager;
let logs: string[];
let echo: net.Server;
let echoPort: number;
let sockets: net.Socket[];
let poolsCreated: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "reoclo-mgr-local-"));
  configPath = join(dir, "tunnels.yaml");
  logs = [];
  sockets = [];
  poolsCreated = 0;
  httpsPort = await freePort();
  saveConfig({ ...emptyConfig(), https_port: httpsPort, ca_suffixes: ["reoclo.test"] }, configPath);
  await createCa(["reoclo.test"], { dir: join(dir, "ca") });
  manager = new TunnelManager({
    configPath,
    log: (line) => logs.push(line),
    certs: new LeafIssuer({ dir: join(dir, "ca") }),
    createPool: () => {
      poolsCreated++;
      throw new Error("a local tunnel must not create a pool");
    },
  });
  echo = net.createServer((s) => {
    sockets.push(s);
    s.on("error", () => s.destroy());
    s.pipe(s);
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", () => resolve()));
  echoPort = (echo.address() as net.AddressInfo).port;
});

afterEach(async () => {
  for (const s of sockets) s.destroy();
  await manager.stop();
  await new Promise<void>((resolve) => echo.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const local = (extra: Record<string, unknown> = {}) => ({
  name: "app",
  kind: "local",
  hostname: HOST,
  local_target: `127.0.0.1:${echoPort}`,
  ...extra,
});

function secureConnect(servername: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: "127.0.0.1", port: httpsPort, servername, ca: readFileSync(join(dir, "ca", "ca.pem")) });
    sockets.push(sock);
    sock.once("secureConnect", () => resolve(sock));
    sock.once("error", reject);
  });
}

function closed(sock: net.Socket): Promise<void> {
  return new Promise((resolve) => (sock.destroyed ? resolve() : sock.once("close", () => resolve())));
}

describe("a local tunnel", () => {
  it("forwards bytes over a real TLS connection to a TCP echo server and counts them", async () => {
    const view = await manager.add(local());
    expect(view.state).toBe("active");
    const sock = await secureConnect(HOST);
    expect(sock.authorized).toBe(true);
    const echoed = new Promise<string>((resolve) => {
      let data = "";
      sock.on("data", (b) => {
        data += b.toString();
        if (data.length >= 5) resolve(data);
      });
    });
    sock.write("hello");
    expect(await echoed).toBe("hello");
    const traffic = manager.get("app").traffic;
    expect(traffic.streams).toBe(1);
    expect(traffic.bytes_in).toBeGreaterThan(0);
    expect(traffic.bytes_out).toBeGreaterThan(0);
    const gone = closed(sock);
    sock.destroy();
    await gone;
    expect(poolsCreated).toBe(0);
  });

  it("returns a view with no org, server or session fields", async () => {
    const view = await manager.add(local());
    expect(view).toMatchObject({
      name: "app",
      org: "",
      server: "",
      server_id: "",
      kind: "local",
      keep_up: false,
      enabled: true,
      state: "active",
      hostname: HOST,
      url: `https://${HOST}:${httpsPort}`,
      local_target: `127.0.0.1:${echoPort}`,
      via: "reoclo",
      path: "relay",
      traffic: { bytes_in: 0, bytes_out: 0, streams: 0 },
    });
    expect(poolsCreated).toBe(0);
  });

  it("fails the handshake for a disabled route and reports it down", async () => {
    await manager.add(local());
    const view = await manager.add(local({ name: "auth", hostname: OTHER, enabled: false }));
    expect(view.state).toBe("down");
    expect(await rejectionOf(secureConnect(OTHER))).toBeInstanceOf(Error);
    (await secureConnect(HOST)).destroy();
  });

  it("brings a route down and up like any saved tunnel", async () => {
    await manager.add(local());
    await manager.add(local({ name: "auth", hostname: OTHER }));
    expect((await manager.down("auth")).state).toBe("down");
    expect(await rejectionOf(secureConnect(OTHER))).toBeInstanceOf(Error);
    expect((await manager.up("auth")).state).toBe("active");
    (await secureConnect(OTHER)).destroy();
  });

  it("closes the client and logs one line when the target refuses", async () => {
    const dead = await freePort();
    await manager.add(local({ local_target: `127.0.0.1:${dead}` }));
    const sock = await secureConnect(HOST);
    await closed(sock);
    const lines = logs.filter((l) => l.includes("could not connect"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`127.0.0.1:${dead}`);
    expect(manager.get("app").state).toBe("active");
  });

  it("includes the hostname in the hosts entries", async () => {
    await manager.add(local());
    expect(manager.hostEntries()).toEqual([{ hostname: HOST, source: "app" }]);
  });

  it("edits the hostname and local target, but not the kind or server fields", async () => {
    await manager.add(local());
    const moved = await manager.edit("app", { local_target: "9999", hostname: "web.reoclo.test" }).catch((e: unknown) => e);
    expect(moved).toBeInstanceOf(Error);
    const ok = await manager.edit("app", { local_target: "127.0.0.1:9999", hostname: "web.reoclo.test" });
    expect(ok).toMatchObject({ hostname: "web.reoclo.test", local_target: "127.0.0.1:9999", state: "active" });
    expect(messageOf(await rejectionOf(manager.edit("app", { kind: "tcp" })))).toContain("cannot change kind");
    expect(messageOf(await rejectionOf(manager.edit("app", { server: "prod-1" })))).toContain("server");
  });

  it("rejects org and server fields on add", async () => {
    expect(messageOf(await rejectionOf(manager.add(local({ org: "acme" }))))).toContain("org");
    expect(poolsCreated).toBe(0);
  });
});
