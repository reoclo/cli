// tests/integration/tunnel-udp-e2e.test.ts
//
// End-to-end smoke test for `reoclo tunnel --udp`.
//
// Mirrors tests/integration/tunnel-e2e.test.ts exactly — the only differences:
//   1. CLI invocation includes `--udp`
//   2. The client probe uses dgram.createSocket instead of net.connect
//   3. The bound-port log line ends with `(udp)` — regex matches that suffix
//
// The mock backend's /v1/tunnel WS handler echoes tunnel_data frames regardless
// of proto, so it works for UDP without any changes.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import dgram from "node:dgram";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ServerWebSocket } from "bun";
import { $ } from "bun";

const TENANT_ID = "00000000-0000-0000-0000-00000000aaaa";
const SERVER_ID = "00000000-0000-0000-0000-00000000cccc"; // UUID → resolveServer short-circuits
const TOKEN = "rk_t_tunnelUDPe2e";

// ---------------------------------------------------------------------------
// Mock backend: HTTP (auth/me) + WS tunnel echo
// ---------------------------------------------------------------------------

interface TunnelBackend {
  url: string;
  stop: () => void;
}

function startTunnelBackend(): TunnelBackend {
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
      message(ws: ServerWebSocket<{ streamId: string | null }>, raw: string | Buffer) {
        let msg: { type?: string; stream_id?: string; data?: string };
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as typeof msg;
        } catch {
          return;
        }

        if (msg.type === "tunnel_open") {
          ws.data.streamId = msg.stream_id ?? null;
          ws.send(JSON.stringify({ type: "tunnel_opened", stream_id: msg.stream_id }));
          return;
        }

        if (msg.type === "tunnel_data") {
          // Echo the data back — the TunnelSession will route it to the original UDP peer
          ws.send(JSON.stringify({ type: "tunnel_data", stream_id: msg.stream_id, data: msg.data }));
          return;
        }
      },
      open() {},
      close() {},
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    stop: () => {
      void server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let tmp: string;
let backend: TunnelBackend;

beforeEach(async () => {
  backend = startTunnelBackend();
  tmp = mkdtempSync(join(tmpdir(), "reoclo-tunnel-udp-e2e-"));

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
});

describe("reoclo tunnel --udp — e2e UDP", () => {
  it("forwards a UDP datagram round-trip through the mock gateway", async () => {
    // `REOCLO_DIRECT_URL` is read directly in tunnel.ts action to build the WS URL.
    // Use ws:// (not http://) — buildTunnelWsUrl prepends /v1/tunnel.
    const directUrl = backend.url.replace(/^http:/, "ws:");

    const cli = spawn(
      "bun",
      ["run", "src/index.ts", "tunnel", SERVER_ID, "--udp", "-L", "0:127.0.0.1:9999"],
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

    // The action prints: `-L  127.0.0.1:<boundPort>  →  ... (udp)` to stdout
    const localPort = await new Promise<number>((resolve, reject) => {
      let stdoutBuf = "";
      let stderrBuf = "";

      cli.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        // Match the bound port from the -L line with (udp) suffix:
        // e.g.: "-L  127.0.0.1:51234  →  ...  (udp)"
        const m = stdoutBuf.match(/127\.0\.0\.1:(\d+).*\(udp\)/);
        if (m) resolve(Number(m[1]));
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
        () => reject(new Error(`CLI did not print bound UDP port within 8s. stdout: ${stdoutBuf} stderr: ${stderrBuf}`)),
        8_000,
      );
    });

    expect(localPort).toBeGreaterThan(0);
    expect(localPort).toBeLessThanOrEqual(65535);

    // Open a real UDP peer and send a datagram to the bound listener
    const peer = dgram.createSocket("udp4");
    await new Promise<void>((r) => peer.bind(0, "127.0.0.1", () => r()));

    const replyPromise = new Promise<Buffer>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("UDP echo did not arrive within 3s")), 3_000);
      peer.once("message", (buf) => {
        clearTimeout(timeout);
        resolve(buf);
      });
    });

    peer.send(Buffer.from("ping"), localPort, "127.0.0.1");
    const reply = await replyPromise;

    expect(reply.toString()).toBe("ping");

    // Cleanup: close dgram socket then kill CLI
    peer.close();
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
