import { messageOf, rejectionOf } from "../../helpers/rejection";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import net from "node:net";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHostsd, type HostsdHandle, type HostsdOptions } from "../../../src/hostsd/main";
import { BLOCK_BEGIN, BLOCK_END, renderBlock } from "../../../src/tunnels/hosts-block";
import { HostsClient, HostsError } from "../../../src/tunnels/hosts-client";
import { freePort } from "../../helpers/fake-ws-gateway";

const SYSTEM = "127.0.0.1\tlocalhost\n::1 localhost\n";
let dir: string;
let hostsFile: string;
let configFile: string;
let socketPath: string;
let handles: HostsdHandle[];
let flushes: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reoclo-hostsd-"));
  hostsFile = join(dir, "hosts");
  configFile = join(dir, "hostsd.json");
  socketPath = join(dir, "run", "hostsd.sock");
  writeFileSync(hostsFile, SYSTEM);
  handles = [];
  flushes = 0;
});
afterEach(async () => {
  for (const h of handles) await h.stop();
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(extra: Record<string, unknown> = {}): void {
  writeFileSync(configFile, JSON.stringify({ version: 1, uid: process.getuid?.() ?? 0, allow_suffixes: [], port_443: false, ...extra }));
}

async function start(extra: Partial<HostsdOptions> = {}): Promise<HostsdHandle> {
  const handle = await startHostsd({
    configFile,
    hostsFile,
    socketPath,
    version: "test",
    flushDns: () => {
      flushes++;
      return Promise.resolve();
    },
    ...extra,
  });
  handles.push(handle);
  return handle;
}

function raw(line: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath);
    let buf = "";
    conn.setEncoding("utf8");
    conn.once("connect", () => conn.write(line + "\n"));
    conn.on("data", (c: string) => {
      buf += c;
      if (!buf.includes("\n")) return;
      conn.destroy();
      resolve(JSON.parse(buf) as Record<string, unknown>);
    });
    conn.once("error", reject);
  });
}

describe("the hosts helper", () => {
  it("answers status with its version, allowlist and entry count", async () => {
    writeConfig({ allow_suffixes: ["internal"] });
    await start();
    const status = await new HostsClient(socketPath).status();
    expect(status).toMatchObject({ version: "test", entries: 0, suffixes: ["internal"], relay: { enabled: false, listening: false } });
  });

  it("creates the socket directory 0700 and the socket 0600", async () => {
    writeConfig();
    await start();
    expect(statSync(join(dir, "run")).mode & 0o777).toBe(0o700);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it("writes the block, leaves other lines alone and flushes the DNS cache", async () => {
    writeConfig();
    await start();
    const status = await new HostsClient(socketPath).set(["b.reoclo.localhost", "a.reoclo.localhost"]);
    expect(status.entries).toBe(2);
    expect(readFileSync(hostsFile, "utf8")).toBe(`${SYSTEM}${renderBlock(["a.reoclo.localhost", "b.reoclo.localhost"])}`);
    expect(flushes).toBe(1);
  });

  it("does not rewrite or flush when nothing changed", async () => {
    writeConfig();
    await start();
    const client = new HostsClient(socketPath);
    await client.set(["a.reoclo.localhost"]);
    await client.set(["a.reoclo.localhost"]);
    expect(flushes).toBe(1);
  });

  it("removes the block when asked to set an empty list", async () => {
    writeConfig();
    await start();
    const client = new HostsClient(socketPath);
    await client.set(["a.reoclo.localhost"]);
    await client.set([]);
    expect(readFileSync(hostsFile, "utf8")).toBe(SYSTEM);
  });

  it("keeps the file's mode and writes through a symlink without replacing it", async () => {
    const real = join(dir, "real-hosts");
    writeFileSync(real, SYSTEM);
    chmodSync(real, 0o640);
    rmSync(hostsFile);
    symlinkSync(real, hostsFile);
    writeConfig();
    await start();
    await new HostsClient(socketPath).set(["a.reoclo.localhost"]);
    expect(lstatSync(hostsFile).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain(BLOCK_BEGIN);
    expect(readFileSync(real, "utf8")).toContain("127.0.0.1 a.reoclo.localhost");
    expect(statSync(real).mode & 0o777).toBe(0o640);
  });

  it("refuses names that are not loopback-safe and leaves the file untouched", async () => {
    writeConfig({ allow_suffixes: ["internal"] });
    await start();
    const client = new HostsClient(socketPath);
    for (const bad of ["github.com", "evil.example.com", "localhost", "a.internal.com", "not a host", "UPPER.reoclo.localhost"]) {
      expect(await rejectionOf(client.set([bad]))).toBeInstanceOf(HostsError);
    }
    expect(messageOf(await rejectionOf(client.set(["ok.reoclo.localhost", "github.com"])))).toMatch(/allowed suffix/);
    expect(readFileSync(hostsFile, "utf8")).toBe(SYSTEM);
    expect(await client.set(["db.internal"])).toBeDefined();
  });

  it("refuses more than 512 hostnames", async () => {
    writeConfig();
    await start();
    const many = Array.from({ length: 513 }, (_, i) => `h${i}.reoclo.localhost`);
    expect(messageOf(await rejectionOf(new HostsClient(socketPath).set(many)))).toMatch(/at most 512/);
    const ok = Array.from({ length: 512 }, (_, i) => `h${i}.reoclo.localhost`);
    expect((await new HostsClient(socketPath).set(ok)).entries).toBe(512);
  });

  it("has no field for an address, and rejects unknown ops and fields", async () => {
    writeConfig();
    await start();
    expect(await raw(JSON.stringify({ op: "set", entries: ["a.reoclo.localhost"], address: "10.0.0.1" }))).toMatchObject({ ok: false });
    expect(await raw(JSON.stringify({ op: "set", entries: [{ host: "a.reoclo.localhost", addr: "10.0.0.1" }] }))).toMatchObject({ ok: false });
    const wipe = await raw(JSON.stringify({ op: "wipe" }));
    expect(wipe["ok"]).toBe(false);
    expect(String(wipe["error"])).toContain("unknown op");
    expect(await raw("not json")).toMatchObject({ ok: false });
    expect(await raw(JSON.stringify([1]))).toMatchObject({ ok: false });
    expect(readFileSync(hostsFile, "utf8")).toBe(SYSTEM);
  });

  it("refuses to touch a damaged block", async () => {
    writeFileSync(hostsFile, `${SYSTEM}${BLOCK_BEGIN}\n127.0.0.1 a.reoclo.localhost\n`);
    writeConfig();
    await start();
    expect(messageOf(await rejectionOf(new HostsClient(socketPath).set(["b.reoclo.localhost"])))).toMatch(/damaged/);
    expect(readFileSync(hostsFile, "utf8")).toContain(BLOCK_BEGIN);
    expect(readFileSync(hostsFile, "utf8")).not.toContain(BLOCK_END);
  });

  it("re-reads its root-owned config on every request", async () => {
    writeConfig();
    await start();
    const client = new HostsClient(socketPath);
    expect(messageOf(await rejectionOf(client.set(["db.internal"])))).toMatch(/allowed suffix/);
    writeConfig({ allow_suffixes: ["internal"] });
    expect(await client.set(["db.internal"])).toBeDefined();
  });

  it("reports a helper that is not installed as not_installed", async () => {
    const err = await new HostsClient(join(dir, "missing.sock")).status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostsError);
    expect((err as HostsError).code).toBe("not_installed");
  });
});

describe("the port 443 relay", () => {
  async function echoServer(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return {
      port: (server.address() as net.AddressInfo).port,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  function roundTrip(port: number, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const c = net.connect(port, "127.0.0.1");
      c.once("data", (b) => {
        c.destroy();
        resolve(b.toString());
      });
      c.once("error", reject);
      c.write(text);
    });
  }

  it("stays off by default", async () => {
    writeConfig();
    const h = await start();
    expect(h.relay()).toEqual({ enabled: false, listening: false });
  });

  it("relays its listen port to the recorded port when nothing answers there", async () => {
    const target = await echoServer();
    const listen = await freePort();
    writeConfig({ port_443: true, relay_port: target.port });
    const h = await start({ relayListenPort: listen });
    expect(h.relay()).toMatchObject({ enabled: true, listening: true, port: target.port });
    expect(await roundTrip(listen, "through-the-relay")).toBe("through-the-relay");
    await h.stop();
    await target.close();
  });

  it("refuses to start while something answers on the port, then starts once it is free", async () => {
    const target = await echoServer();
    const blocker = await echoServer();
    writeConfig({ port_443: true, relay_port: target.port });
    const h = await start({ relayListenPort: blocker.port });
    expect(h.relay()).toMatchObject({ enabled: true, listening: false });
    expect(h.relay().error).toContain("already answers");

    await blocker.close();
    await new HostsClient(socketPath).status();
    expect(h.relay()).toMatchObject({ listening: true });
    await h.stop();
    await target.close();
  });

  it("only forwards to the port in its config", async () => {
    const recorded = await echoServer();
    const other = await echoServer();
    const listen = await freePort();
    writeConfig({ port_443: true, relay_port: recorded.port });
    const h = await start({ relayListenPort: listen });
    expect(h.relay().port).toBe(recorded.port);
    expect(h.relay().port).not.toBe(other.port);
    await h.stop();
    await recorded.close();
    await other.close();
  });

  it("replaces a stale socket file left by a crashed helper", async () => {
    writeConfig();
    mkdirSync(join(dir, "run"), { recursive: true });
    writeFileSync(socketPath, "stale");
    await start();
    expect((await new HostsClient(socketPath).status()).version).toBe("test");
  });
});
