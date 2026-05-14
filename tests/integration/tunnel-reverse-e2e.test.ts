// tests/integration/tunnel-reverse-e2e.test.ts
//
// End-to-end smoke test for `reoclo tunnel -R` (reverse TCP).
//
// Mirrors tests/integration/tunnel-e2e.test.ts in structure. Key differences:
//   1. CLI invocation uses `-R <remotePort>:127.0.0.1:<targetPort>`
//   2. The mock backend intercepts `tunnel_listen_open`, acks with `tunnel_listen_opened`,
//      then emits `tunnel_open` (inbound) + `tunnel_data` toward the CLI.
//   3. A real local TCP echo server acts as the target the CLI dials on inbound.
//   4. The test asserts the mock gateway receives the echo back via `tunnel_data`.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ServerWebSocket } from "bun";
import { $ } from "bun";

const TENANT_ID = "00000000-0000-0000-0000-00000000aaaa";
const SERVER_ID = "00000000-0000-0000-0000-00000000dddd"; // UUID → resolveServer short-circuits
const TOKEN = "rk_t_tunnelREVe2e";

// ---------------------------------------------------------------------------
// Mock backend: HTTP (auth/me) + WS gateway stub for reverse tunnels
// ---------------------------------------------------------------------------

interface TunnelBackend {
  url: string;
  stop: () => void;
  /** Resolves when the mock receives tunnel_data from the CLI for the given
   *  stream_id whose base64-decoded payload matches expectedDecoded. */
  waitForEchoData: (streamId: string, expectedDecoded: string, timeoutMs: number) => Promise<boolean>;
}

function startTunnelBackend(): TunnelBackend {
  // Capture tunnel_data frames arriving from the CLI, keyed by stream_id.
  // Each entry holds the accumulated decoded payloads so we can match substrings.
  const receivedData = new Map<string, string>();
  const echoWaiters: Array<{ streamId: string; expected: string; resolve: (v: boolean) => void; reject: (e: Error) => void }> = [];

  function notifyWaiters() {
    for (let i = echoWaiters.length - 1; i >= 0; i--) {
      const w = echoWaiters[i]!;
      const accumulated = receivedData.get(w.streamId) ?? "";
      if (accumulated.includes(w.expected)) {
        w.resolve(true);
        echoWaiters.splice(i, 1);
      }
    }
  }

  // Holds the live WS so the reverse orchestration can send messages later.
  let liveWs: ServerWebSocket<{ streamId: string | null }> | null = null;

  const server = Bun.serve<{ streamId: string | null }>({
    port: 0,

    fetch(req, srv) {
      const url = new URL(req.url);

      // 1. Auth probe used by `reoclo login` and bootstrap
      if (url.pathname === "/mcp/auth/me") {
        if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
          return new Response("unauth", { status: 401 });
        }
        return Response.json({
          id: "user-1",
          email: "test@example.com",
          tenant_id: TENANT_ID,
          tenant_slug: "acme",
          roles: ["member"],
        });
      }

      // 2. Gateway WebSocket endpoint: /v1/tunnel?server_id=<UUID>
      if (url.pathname === "/v1/tunnel") {
        const upgraded = srv.upgrade(req, { data: { streamId: null } });
        if (upgraded) return undefined;
        return new Response("ws upgrade failed", { status: 500 });
      }

      return new Response("not found", { status: 404 });
    },

    websocket: {
      open(ws) {
        liveWs = ws;
      },
      message(ws: ServerWebSocket<{ streamId: string | null }>, raw: string | Buffer) {
        let msg: { type?: string; stream_id?: string; listen_id?: string; data?: string };
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as typeof msg;
        } catch {
          return;
        }

        if (msg.type === "tunnel_listen_open") {
          const listenId = msg.listen_id;
          // Ack the reverse listener with a fake port (9999)
          ws.send(JSON.stringify({ type: "tunnel_listen_opened", listen_id: listenId, port: 9999 }));

          // Simulate an inbound connection from the runner ~50 ms later
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: "tunnel_open",
              stream_id: "s-rev-e2e",
              proto: "tcp",
              host: "1.2.3.4",
              port: 1234,
              listen_id: listenId,
            }));

            // Send tunnel_data ~50 ms after tunnel_open so the CLI has time to dial local target
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: "tunnel_data",
                stream_id: "s-rev-e2e",
                data: Buffer.from("hello").toString("base64"),
              }));
            }, 50);
          }, 50);
          return;
        }

        if (msg.type === "tunnel_data") {
          const sid = msg.stream_id ?? "";
          const decoded = Buffer.from(msg.data ?? "", "base64").toString();
          const prev = receivedData.get(sid) ?? "";
          receivedData.set(sid, prev + decoded);
          notifyWaiters();
          return;
        }
      },
      close() {
        liveWs = null;
      },
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    stop: () => {
      void server.stop(true);
    },
    waitForEchoData(streamId, expectedDecoded, timeoutMs) {
      return new Promise<boolean>((resolve, reject) => {
        // Check immediately in case the frame arrived before this call
        const accumulated = receivedData.get(streamId) ?? "";
        if (accumulated.includes(expectedDecoded)) {
          resolve(true);
          return;
        }
        const timer = setTimeout(() => {
          const idx = echoWaiters.findIndex((w) => w.streamId === streamId && w.expected === expectedDecoded);
          if (idx !== -1) echoWaiters.splice(idx, 1);
          reject(new Error(`waitForEchoData: timeout after ${timeoutMs}ms for stream_id=${streamId}. Got: "${accumulated}"`));
        }, timeoutMs);
        echoWaiters.push({
          streamId,
          expected: expectedDecoded,
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let tmp: string;
let backend: TunnelBackend;
let targetServer: net.Server;
let targetPort: number;

beforeEach(async () => {
  backend = startTunnelBackend();
  tmp = mkdtempSync(join(tmpdir(), "reoclo-tunnel-rev-e2e-"));

  // Local TCP echo server — the CLI dials this when a reverse-inbound arrives
  targetServer = net.createServer((sock) => sock.pipe(sock));
  await new Promise<void>((r) => targetServer.listen(0, "127.0.0.1", () => r()));
  targetPort = (targetServer.address() as net.AddressInfo).port;

  // Populate the profile so bootstrap() can read tenant_id.
  // --no-keyring writes the token directly to the config file (no system keyring).
  await $`bun run src/index.ts login --token ${TOKEN} --api ${backend.url} --no-keyring`
    .env({
      ...process.env,
      REOCLO_CONFIG_DIR: tmp,
      REOCLO_CACHE_DIR: join(tmp, "cache"),
    })
    .quiet();
});

afterEach(() => {
  backend.stop();
  targetServer?.close();
});

describe("reoclo tunnel -R — e2e reverse TCP", () => {
  it("CLI dials local target on inbound tunnel_open and echoes data back to the gateway", async () => {
    // `REOCLO_DIRECT_URL` is read directly in tunnel.ts action to build the WS URL.
    // Use ws:// (not http://) — buildTunnelWsUrl prepends /v1/tunnel.
    const directUrl = backend.url.replace(/^http:/, "ws:");

    const cli = spawn(
      "bun",
      ["run", "src/index.ts", "tunnel", SERVER_ID, "-R", `8080:127.0.0.1:${targetPort}`],
      {
        cwd: join(import.meta.dir, "../.."),
        env: {
          ...process.env,
          REOCLO_CONFIG_DIR: tmp,
          REOCLO_CACHE_DIR: join(tmp, "cache"),
          REOCLO_DIRECT_URL: directUrl,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    // The action prints: `-R  <server>:<boundPort>  →  127.0.0.1:<localPort>  (tcp)` to stdout
    const matched = await new Promise<boolean>((resolve, reject) => {
      let stdoutBuf = "";
      let stderrBuf = "";

      cli.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        // Match the -R line: "-R  <server>:9999  →  127.0.0.1:<targetPort>  (tcp)"
        if (/-R\s+\S+:\d+\s+→\s+127\.0\.0\.1:\d+\s+\(tcp\)/.test(stdoutBuf)) {
          resolve(true);
        }
      });

      cli.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      cli.on("error", reject);
      cli.on("exit", (code) => {
        if (code !== null && code !== 0) {
          reject(new Error(`CLI exited early with code ${code}. stderr: ${stderrBuf}`));
        }
      });

      setTimeout(
        () => reject(new Error(`CLI did not print -R line within 8s. stdout: ${stdoutBuf} stderr: ${stderrBuf}`)),
        8_000,
      );
    });

    expect(matched).toBe(true);

    // Wait for the mock gateway to receive the echo back via tunnel_data from the CLI.
    // The echo server mirrors whatever the CLI sends, so if the CLI forwarded "hello"
    // to the echo server and got "hello" back, it will send tunnel_data with "hello"
    // back toward the gateway.
    const echoArrived = await backend.waitForEchoData("s-rev-e2e", "hello", 5_000);
    expect(echoArrived).toBe(true);

    // Cleanup: kill CLI
    cli.kill("SIGINT");
    await new Promise<void>((resolve) => {
      cli.once("exit", () => resolve());
      // Safety: if SIGINT isn't enough, force kill after 2s
      setTimeout(() => {
        cli.kill("SIGKILL");
        resolve();
      }, 2_000);
    });
  }, 20_000); // generous timeout for bun process startup
});
