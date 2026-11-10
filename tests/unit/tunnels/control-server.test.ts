import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, daemonResponding, type DaemonError } from "../../../src/tunnels/control-client";
import { startControlServer, type ControlServer } from "../../../src/tunnels/control-server";
import { TunnelManager } from "../../../src/tunnels/manager";
import { FakePool } from "../../helpers/fake-pool";
import { freePort } from "../../helpers/fake-ws-gateway";

let dir: string;
let socket: string;
let manager: TunnelManager;
let server: ControlServer;
let client: ControlClient;
let pool: FakePool;
let shutdown: Promise<void>;
const logs: string[] = [];

const base = { org: "acme", tenant_id: "t1", server: "prod-1", server_id: "s1" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-"));
  socket = join(dir, "run", "tunneld.sock");
  pool = new FakePool();
  manager = new TunnelManager({ configPath: join(dir, "tunnels.yaml"), createPool: () => pool });
  let onShutdown!: () => void;
  shutdown = new Promise<void>((r) => (onShutdown = r));
  server = startControlServer({
    socketPath: socket,
    manager,
    version: "9.9.9",
    executable: "/opt/homebrew/bin/reoclo",
    startedAt: Date.now(),
    stateDir: dir,
    log: (l) => logs.push(l),
    onShutdown,
    trafficIntervalMs: 20,
  });
  client = new ControlClient(socket);
});
afterEach(async () => {
  await server.stop();
  await manager.stop();
  rmSync(dir, { recursive: true, force: true });
});

const newTunnel = async (name: string, extra: Record<string, unknown> = {}) => ({
  ...base,
  name,
  kind: "tcp",
  target: "127.0.0.1:5432",
  local_port: await freePort(),
  ...extra,
});

describe("control server", () => {
  it("serves status with the version, pid and tunnel counts", async () => {
    await client.add(await newTunnel("a"));
    await client.add(await newTunnel("b", { enabled: false }));
    const s = await client.status();
    expect(s).toMatchObject({ version: "9.9.9", executable: "/opt/homebrew/bin/reoclo", pid: process.pid, state_dir: dir, socket });
    expect(s.tunnels).toMatchObject({ total: 2, enabled: 1 });
    expect(s.tunnels.by_state).toMatchObject({ ready: 1, down: 1 });
  });

  it("creates, lists, reads, edits, brings down and up, and deletes tunnels", async () => {
    const created = await client.add(await newTunnel("prod-db"));
    expect(created).toMatchObject({ name: "prod-db", state: "ready", message: "Listening, no session open" });
    expect((await client.tunnels()).map((t) => t.name)).toEqual(["prod-db"]);
    expect((await client.tunnel("prod-db")).kind).toBe("tcp");
    expect((await client.edit("prod-db", { target: "10.0.0.1:80" })).target).toBe("10.0.0.1:80");
    expect((await client.down("prod-db")).state).toBe("down");
    expect((await client.up("prod-db")).state).toBe("ready");
    await client.remove("prod-db");
    expect(await client.tunnels()).toEqual([]);
  });

  it("answers errors as JSON with 400, 404 and 409", async () => {
    await client.add(await newTunnel("a"));
    const status = async (p: Promise<unknown>): Promise<DaemonError> => {
      try {
        await p;
      } catch (e) {
        return e as DaemonError;
      }
      throw new Error("expected an error");
    };
    expect(await status(client.tunnel("nope"))).toMatchObject({ status: 404, code: "not_found" });
    expect(await status(client.add(await newTunnel("a")))).toMatchObject({ status: 409, code: "conflict" });
    expect(await status(client.add({ name: "x" }))).toMatchObject({ status: 400, code: "invalid" });
    expect(await status(client.request("GET", "/v1/nothing"))).toMatchObject({ status: 404 });
    const res = await fetch("http://localhost/v1/tunnels", { unix: socket, method: "POST", body: "{not json" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid");
  });

  it("logs the client name from X-Reoclo-Client on mutating requests", async () => {
    await fetch("http://localhost/v1/tunnels", {
      unix: socket,
      method: "POST",
      headers: { "x-reoclo-client": "app", "content-type": "application/json" },
      body: JSON.stringify(await newTunnel("a")),
    });
    expect(logs.some((l) => l.includes("POST /v1/tunnels from app -> 201"))).toBe(true);
  });

  it("asks the daemon to shut down after answering", async () => {
    await client.shutdown();
    await shutdown;
  });

  it("keeps the run directory private and the socket owner-only", () => {
    expect(statSync(join(dir, "run")).mode & 0o777).toBe(0o700);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
  });

  it("answers daemonResponding while up and not after stop", async () => {
    expect(await daemonResponding(socket)).toBe(true);
    await server.stop();
    expect(await daemonResponding(socket)).toBe(false);
    server = startControlServer({ socketPath: socket, manager, version: "1", startedAt: Date.now(), stateDir: dir, log: () => undefined, onShutdown: () => undefined });
  });
});

describe("event stream", () => {
  async function readUntil(res: Response, needle: string, timeoutMs = 5000): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const timer = setTimeout(() => void reader.cancel(), timeoutMs);
    try {
      while (!text.includes(needle)) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    } finally {
      clearTimeout(timer);
      await reader.cancel().catch(() => undefined);
    }
    return text;
  }

  it("streams tunnel state changes", async () => {
    await client.add(await newTunnel("a"));
    const res = await fetch("http://localhost/v1/events", { unix: socket });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reading = readUntil(res, '"state":"connecting"');
    pool.setState({ state: "connecting" });
    const text = await reading;
    expect(text).toContain("event: tunnel");
    expect(text).toContain('"name":"a"');
  });

  it("streams traffic while a tunnel is active", async () => {
    await client.add(await newTunnel("a"));
    pool.setState({ state: "active" });
    const res = await fetch("http://localhost/v1/events", { unix: socket });
    const text = await readUntil(res, "event: traffic");
    expect(text).toContain("event: traffic");
    expect(text).toContain('"bytes_in":0');
  });

  it("streams log lines", async () => {
    const res = await fetch("http://localhost/v1/events", { unix: socket });
    const reading = readUntil(res, "event: log");
    await client.add(await newTunnel("a", { enabled: false }));
    // The add itself does not log through the manager; a pool change does.
    await client.add(await newTunnel("b"));
    pool.setState({ state: "connecting" });
    expect(await reading).toContain("event: log");
  });
});
