// tests/integration/tunnel-https.test.ts
//
// Local HTTPS end to end: a saved https tunnel served by the daemon's TLS proxy
// with a certificate signed by the local CA, carried over a pooled session to a
// fake gateway. The daemon runs in this process with a temp config dir and a
// fake hosts helper, so nothing touches the keychain, /etc/hosts or a real port.

import { messageOf, rejectionOf } from "../helpers/rejection";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import net from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { LeafIssuer, createCa } from "../../src/tunnels/ca";
import { emptyConfig, saveConfig } from "../../src/tunnels/config";
import { ControlClient } from "../../src/tunnels/control-client";
import { startDaemon, type DaemonHandle } from "../../src/tunnels/daemon";
import { HostsError, type HelperStatus, type HostsSink } from "../../src/tunnels/hosts-client";
import { caCertFile, caDir, tunnelsFile } from "../../src/tunnels/paths";
import { freePort, startFakeWsGateway, type FakeWsGateway } from "../helpers/fake-ws-gateway";
import { seedTenantProfile } from "../helpers/seed-profile";

const TENANT_ID = "00000000-0000-0000-0000-00000000aaaa";
const SERVER_ID = "00000000-0000-0000-0000-00000000bbbb";
const HOST = "grafana.prod-1.reoclo.localhost";

class FakeHosts implements HostsSink {
  sets: string[][] = [];
  failWith?: Error;
  relay: HelperStatus["relay"] = { enabled: false, listening: false };
  private status0(): HelperStatus {
    return { version: "fake", entries: this.sets.at(-1)?.length ?? 0, suffixes: [], relay: this.relay };
  }
  status(): Promise<HelperStatus> {
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve(this.status0());
  }
  set(entries: readonly string[]): Promise<HelperStatus> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.sets.push([...entries]);
    return Promise.resolve(this.status0());
  }
}

let tmp: string;
let gw: FakeWsGateway | undefined;
let daemon: DaemonHandle | undefined;
let hosts: FakeHosts;
let httpsPort: number;
let saved: Record<string, string | undefined>;

function setEnv(key: string, value: string): void {
  if (!(key in saved)) saved[key] = process.env[key];
  process.env[key] = value;
}

beforeEach(async () => {
  saved = {};
  tmp = mkdtempSync(join(tmpdir(), "rt-https-"));
  setEnv("REOCLO_CONFIG_DIR", tmp);
  setEnv("REOCLO_CACHE_DIR", join(tmp, "cache"));
  seedTenantProfile({ configDir: tmp, apiUrl: "http://127.0.0.1:1", token: "rk_t_daemon", tenantId: TENANT_ID });
  httpsPort = await freePort();
  saveConfig({ ...emptyConfig(), idle_timeout_seconds: 0.3, https_port: httpsPort }, tunnelsFile());
  hosts = new FakeHosts();
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await gw?.stop();
  gw = undefined;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function boot(gateway: { echo?: boolean; http?: boolean }, opts: { ca?: boolean } = {}): Promise<ControlClient> {
  gw = await startFakeWsGateway(gateway);
  if (opts.ca !== false) await createCa([], { dir: caDir() });
  daemon = await startDaemon({ directUrl: gw.url, log: () => undefined, certs: new LeafIssuer(), hosts });
  return new ControlClient(daemon.socketPath);
}

const base = { org: "acme", tenant_id: TENANT_ID, profile: "default", server: "prod-1", server_id: SERVER_ID };

function addHttps(client: ControlClient, name = "grafana", hostname = HOST): Promise<unknown> {
  return client.add({ ...base, name, kind: "https", target: "127.0.0.1:3000", hostname });
}

const caPem = (): string => readFileSync(caCertFile(), "utf8");

/** Connect over TLS, send `payload`, and resolve with everything read once `done` holds. */
function tlsExchange(servername: string, payload: string, done: (data: string) => boolean): Promise<{ data: string; authorized: boolean }> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: "127.0.0.1", port: httpsPort, servername, ca: caPem() });
    let data = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`timed out; got ${JSON.stringify(data)}`));
    }, 5000);
    sock.once("secureConnect", () => sock.write(Buffer.from(payload, "latin1")));
    sock.on("data", (b) => {
      data += b.toString("latin1");
      if (!done(data)) return;
      clearTimeout(timer);
      const authorized = sock.authorized;
      sock.destroy();
      resolve({ data, authorized });
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** Resolve true when the TLS handshake completes, false when it is refused. */
function handshakes(servername: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = tls.connect({ host: "127.0.0.1", port: httpsPort, servername, ca: caPem() });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 5000);
    sock.once("secureConnect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

describe("a saved https tunnel", () => {
  it("answers over TLS with a certificate that verifies against the local CA", async () => {
    const client = await boot({ http: true });
    await addHttps(client);
    const { data, authorized } = await tlsExchange(HOST, `GET /dash HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`, (d) => d.includes("fake gateway saw"));
    expect(authorized).toBe(true);
    expect(data).toContain("200 OK");
    expect(data).toContain("fake gateway saw: GET /dash HTTP/1.1");
    const open = gw!.frames.find((f) => f["type"] === "tunnel_open");
    expect(open).toMatchObject({ host: "127.0.0.1", port: 3000 });
  });

  it.skipIf(Bun.which("curl") === null)("opens with curl --cacert at https://<hostname>:<port>", async () => {
    const client = await boot({ http: true });
    await addHttps(client);
    const url = `https://${HOST}:${httpsPort}/from-curl`;
    const proc = Bun.spawn(
      ["curl", "--silent", "--show-error", "--max-time", "10", "--cacert", caCertFile(), "--resolve", `${HOST}:${httpsPort}:127.0.0.1`, url],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0);
    expect(err).toBe("");
    expect(out).toBe("fake gateway saw: GET /from-curl HTTP/1.1");
  });

  it("refuses the handshake for a hostname no tunnel answers to", async () => {
    const client = await boot({ http: true });
    await addHttps(client);
    expect(await handshakes(HOST)).toBe(true);
    expect(await handshakes("nobody.prod-1.reoclo.localhost")).toBe(false);
    expect(await handshakes("example.com")).toBe(false);
  });

  it("refuses the handshake for a tunnel that is down, and again accepts it after up", async () => {
    const client = await boot({ http: true });
    await addHttps(client);
    await client.down("grafana");
    expect(await handshakes(HOST)).toBe(false);
    await client.up("grafana");
    expect(await handshakes(HOST)).toBe(true);
  });

  it("refuses the handshake when there is no local CA yet", async () => {
    const client = await boot({ http: true }, { ca: false });
    await addHttps(client);
    const status = await client.status();
    expect(status.ca).toMatchObject({ exists: false, trusted: false });
    const sock = await new Promise<boolean>((resolve) => {
      const s = tls.connect({ host: "127.0.0.1", port: httpsPort, servername: HOST, rejectUnauthorized: false });
      s.once("secureConnect", () => (s.destroy(), resolve(true)));
      s.once("error", () => resolve(false));
    });
    expect(sock).toBe(false);
  });

  it("shares one gateway session with a tcp tunnel to the same server", async () => {
    const client = await boot({ echo: true });
    await addHttps(client);
    const tcpPort = await freePort();
    await client.add({ ...base, name: "prod-db", kind: "tcp", target: "127.0.0.1:5432", local_port: tcpPort });

    const viaTls = await tlsExchange(HOST, "ping-over-tls", (d) => d === "ping-over-tls");
    expect(viaTls.data).toBe("ping-over-tls");
    const viaTcp = await new Promise<string>((resolve, reject) => {
      const s = net.connect(tcpPort, "127.0.0.1");
      s.once("data", (b) => (s.destroy(), resolve(b.toString())));
      s.once("error", reject);
      s.write("ping-over-tcp");
    });
    expect(viaTcp).toBe("ping-over-tcp");

    expect(gw!.connections).toBe(1);
    const opens = gw!.frames.filter((f) => f["type"] === "tunnel_open").map((f) => [f["host"], f["port"]]);
    expect(opens).toEqual([
      ["127.0.0.1", 3000],
      ["127.0.0.1", 5432],
    ]);
  });

  it("passes WebSocket upgrade bytes through untouched", async () => {
    const client = await boot({ echo: true });
    await addHttps(client);
    const upgrade =
      `GET /socket HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
    const frame = "\u0081\u0085\u0001\u0002\u0003\u0004hello";
    const { data } = await tlsExchange(HOST, upgrade + frame, (d) => d.length >= upgrade.length + frame.length);
    expect(data).toBe(upgrade + frame);
  });

  it("negotiates http/1.1 only", async () => {
    const client = await boot({ http: true });
    await addHttps(client);
    const protocol = await new Promise<string | false | null>((resolve, reject) => {
      const s = tls.connect({ host: "127.0.0.1", port: httpsPort, servername: HOST, ca: caPem(), ALPNProtocols: ["h2", "http/1.1"] });
      s.once("secureConnect", () => {
        const p = s.alpnProtocol;
        s.destroy();
        resolve(p);
      });
      s.once("error", reject);
    });
    expect(protocol).toBe("http/1.1");
  });
});

describe("the https listener", () => {
  it("shows every https tunnel as failed with the reason when the port is taken, and recovers on up", async () => {
    const taken = net.createServer();
    await new Promise<void>((r) => taken.listen(httpsPort, "127.0.0.1", () => r()));
    const client = await boot({ http: true });
    const view = (await addHttps(client)) as { state: string; detail?: string };
    expect(view.state).toBe("failed");
    expect(view.detail).toMatch(new RegExp(`port ${httpsPort} is already in use`));
    expect((await client.status()).https).toMatchObject({ port: httpsPort, listening: false });
    expect((await client.status()).https?.error).toMatch(/already in use/);

    await new Promise<void>((r) => taken.close(() => r()));
    const up = await client.up("grafana");
    expect(up.state).toBe("ready");
    expect((await client.status()).https).toMatchObject({ listening: true });
  });

  it("only binds when an https tunnel is up, and lets go when the last one goes down", async () => {
    const client = await boot({ http: true });
    expect((await client.status()).https).toMatchObject({ listening: false });
    await addHttps(client);
    expect((await client.status()).https).toMatchObject({ listening: true });
    await client.down("grafana");
    expect((await client.status()).https).toMatchObject({ listening: false });
    await client.up("grafana");
    expect((await client.status()).https).toMatchObject({ listening: true });
  });

  it("moves to a new port when https_port changes", async () => {
    const client = await boot({ http: true });
    await addHttps(client);
    const next = await freePort();
    await client.updateSettings({ https_port: next });
    expect((await client.status()).https).toMatchObject({ port: next, listening: true });
    expect((await client.tunnel("grafana")).url).toBe(`https://${HOST}:${next}`);
  });
});

describe("tunnel URLs", () => {
  it("carry the port, and drop it once the helper relays 443 to the proxy", async () => {
    const client = await boot({ http: true });
    const view = (await addHttps(client)) as { url: string };
    expect(view.url).toBe(`https://${HOST}:${httpsPort}`);

    hosts.relay = { enabled: true, listening: true, port: httpsPort };
    await client.syncHosts();
    expect((await client.tunnel("grafana")).url).toBe(`https://${HOST}`);

    hosts.relay = { enabled: true, listening: false, port: httpsPort, error: "something answers on 443" };
    await client.syncHosts();
    expect((await client.tunnel("grafana")).url).toBe(`https://${HOST}:${httpsPort}`);
  });

  it("report the CA and the helper in daemon status", async () => {
    const client = await boot({ http: true });
    const status = await client.status();
    expect(status.ca).toMatchObject({ exists: true, trusted: false, stale: false, suffixes: ["reoclo.localhost"] });
    expect(status.ca?.path).toBe(caCertFile());
    expect(status.hosts).toMatchObject({ installed: true, entries: 0 });
  });
});

describe("the hosts block", () => {
  it("is sent in full after every hostname change, with manual hosts and tcp hostnames", async () => {
    const client = await boot({ http: true });
    await addHttps(client);
    await client.add({ ...base, name: "prod-db", kind: "tcp", target: "127.0.0.1:5432", local_port: await freePort(), hostname: "db.prod-1.reoclo.localhost" });
    await client.updateSettings({ manual_hosts: ["scratch.localhost"] });
    await daemon!.manager.syncHosts();
    expect(hosts.sets.at(-1)).toEqual([
      "db.prod-1.reoclo.localhost",
      HOST,
      "scratch.localhost",
    ]);
    expect((await client.hosts()).entries).toEqual([
      { hostname: "db.prod-1.reoclo.localhost", source: "prod-db" },
      { hostname: HOST, source: "grafana" },
      { hostname: "scratch.localhost", source: "manual" },
    ]);

    await client.remove("prod-db");
    await daemon!.manager.syncHosts();
    expect(hosts.sets.at(-1)).toEqual([HOST, "scratch.localhost"]);
  });

  it("keeps a tunnel working and shows the error when the helper refuses", async () => {
    hosts.failWith = new HostsError("refused", "github.com does not end in .localhost or an allowed suffix");
    const client = await boot({ http: true });
    const view = (await addHttps(client)) as { state: string };
    expect(view.state).not.toBe("failed");
    const listing = await client.syncHosts();
    expect(listing.helper.installed).toBe(true);
    expect(listing.helper.error).toContain("allowed suffix");
    expect((await client.status()).hosts?.error).toBeDefined();
    const { data } = await tlsExchange(HOST, `GET / HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`, (d) => d.includes("fake gateway saw"));
    expect(data).toContain("200 OK");
  });

  it("reports a helper that is not installed without calling it an error", async () => {
    hosts.failWith = new HostsError("not_installed", "the hosts helper is not installed");
    const client = await boot({ http: true });
    await addHttps(client);
    const listing = await client.syncHosts();
    expect(listing.helper.installed).toBe(false);
    expect(listing.helper.error).toBeUndefined();
  });

  it("rejects a hostname outside reoclo.localhost and the CA suffixes", async () => {
    const client = await boot({ http: true });
    expect(messageOf(await rejectionOf(addHttps(client, "bad", "grafana.example.com")))).toMatch(/must end in reoclo.localhost/);
    await client.updateSettings({ ca_suffixes: ["internal"] });
    const view = (await addHttps(client, "internal-one", "grafana.internal")) as { url: string };
    expect(view.url).toBe(`https://grafana.internal:${httpsPort}`);
    expect(messageOf(await rejectionOf(client.updateSettings({ ca_suffixes: [] })))).toMatch(/must end in reoclo.localhost/);
    expect((await client.status()).ca?.stale).toBe(true);
  });
});
