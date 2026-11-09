import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../../../src/tunnels/control-client";
import { startControlServer, type ControlServer } from "../../../src/tunnels/control-server";
import { ForegroundNotFound, type ForegroundTunnel } from "../../../src/tunnels/foreground";
import { TunnelManager } from "../../../src/tunnels/manager";
import { FakePool } from "../../helpers/fake-pool";

let dir: string;
let socket: string;
let manager: TunnelManager;
let server: ControlServer;
let client: ControlClient;
let tunnels: ForegroundTunnel[];
let stopped: string[];

const entry: ForegroundTunnel = {
  id: "4242",
  pid: 4242,
  org: "envdev",
  server: "omo-assistant-prod-01",
  state: "active",
  started_at: "2026-11-09T10:00:00.000Z",
  forwards: [{ kind: "forward", proto: "tcp", listen: "127.0.0.1:7700", target: "127.0.0.1:7700" }],
};

const stop = (id: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`http://localhost/v1/foreground/${id}/stop`, { unix: socket, method: "POST", headers });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-"));
  socket = join(dir, "run", "tunneld.sock");
  tunnels = [];
  stopped = [];
  manager = new TunnelManager({ configPath: join(dir, "tunnels.yaml"), createPool: () => new FakePool() });
  server = startControlServer({
    socketPath: socket,
    manager,
    version: "9.9.9",
    startedAt: Date.now(),
    stateDir: dir,
    log: () => undefined,
    onShutdown: () => undefined,
    trafficIntervalMs: 5,
    foreground: {
      list: () => tunnels,
      stop: (id) => {
        if (id !== entry.id) return Promise.reject(new ForegroundNotFound(`no terminal tunnel with id "${id}"`));
        stopped.push(id);
        return Promise.resolve();
      },
    },
  });
  client = new ControlClient(socket);
});
afterEach(async () => {
  await server.stop();
  await manager.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("terminal tunnels on the control socket", () => {
  it("lists them", async () => {
    tunnels = [entry];
    expect(await client.foreground()).toEqual([entry]);
  });

  it("stops one by id", async () => {
    const res = await stop("4242");
    expect(res.status).toBe(200);
    expect(stopped).toEqual(["4242"]);
  });

  it("answers 404 for an unknown id", async () => {
    expect((await stop("9")).status).toBe(404);
    expect(stopped).toEqual([]);
  });

  it("does not let an agent stop someone's terminal", async () => {
    const res = await stop("4242", { "x-reoclo-client": "mcp", "x-reoclo-agent": "a coding agent" });
    expect(res.status).toBe(403);
    expect(stopped).toEqual([]);
  });

  it("pushes an event when the list changes", async () => {
    const res = await fetch("http://localhost/v1/events", { unix: socket });
    const reader = res.body!.getReader();
    tunnels = [entry];
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("event: foreground")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value);
    }
    await reader.cancel();
    expect(seen).toContain('"omo-assistant-prod-01"');
  });
});
