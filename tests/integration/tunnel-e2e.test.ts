// tests/integration/tunnel-e2e.test.ts
//
// End-to-end smoke test for `reoclo tunnel`.
//
// Approach: subprocess (full argv → parseTunnelArgs → bootstrap → TunnelSession → WS).
// A single Bun.serve instance acts as both the HTTP API stub and the gateway-ws
// echo server. The CLI is started via `bun run src/index.ts tunnel <UUID> -L …`.
//
// Why UUID for the server identifier?
//   resolveServer() short-circuits on UUID input — no HTTP call is made to list
//   servers — so the HTTP stub only needs to handle /mcp/auth/me (for login).
//
// Why run `reoclo login` first?
//   bootstrap() reads tenant_id from the stored profile. REOCLO_API_KEY alone
//   does not carry tenant_id, and requireTenantId() throws if it is absent.
//   The login call (same pattern as tests/integration/shell.test.ts) writes the
//   profile to an isolated REOCLO_CONFIG_DIR temp directory.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ServerWebSocket } from "bun";
import { $ } from "bun";

const TENANT_ID = "00000000-0000-0000-0000-00000000aaaa";
const SERVER_ID = "00000000-0000-0000-0000-00000000bbbb"; // UUID → resolveServer short-circuits
const TOKEN = "rk_t_tunnele2e";

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
          // Echo the data back — the TunnelSession will route it to the local TCP socket
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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-tunnel-e2e-"));

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

describe("reoclo tunnel — e2e forward TCP", () => {
  it("forwards bytes through the CLI to a mock gateway and echoes back", async () => {
    // `REOCLO_DIRECT_URL` is read directly in tunnel.ts action to build the WS URL.
    // Use ws:// (not http://) — buildTunnelWsUrl prepends /v1/tunnel.
    const directUrl = backend.url.replace(/^http:/, "ws:");

    const cli = spawn(
      "bun",
      ["run", "src/index.ts", "tunnel", SERVER_ID, "-L", "0:127.0.0.1:5432"],
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

    // The action prints: `-L  127.0.0.1:<boundPort>  →  ...` to stdout
    const localPort = await new Promise<number>((resolve, reject) => {
      let stdoutBuf = "";
      let stderrBuf = "";

      cli.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        // Match the bound port from the -L line, e.g.: "-L  127.0.0.1:51234  →  ..."
        const m = stdoutBuf.match(/127\.0\.0\.1:(\d+)/);
        if (m) resolve(Number(m[1]));
      });

      cli.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        // Surface stderr for debugging; also watch for the "connected" status line
        // which is printed before stdout
        const m = stderrBuf.match(/tunnel: connected/);
        if (m) {
          // stdout -L line should follow shortly — keep waiting
        }
      });

      cli.on("error", reject);
      cli.on("exit", (code) => {
        if (code !== null && code !== 0) {
          reject(new Error(`CLI exited early with code ${code}. stderr: ${stderrBuf}`));
        }
      });

      setTimeout(
        () => reject(new Error(`CLI did not print bound port within 8s. stdout: ${stdoutBuf} stderr: ${stderrBuf}`)),
        8_000,
      );
    });

    expect(localPort).toBeGreaterThan(0);
    expect(localPort).toBeLessThanOrEqual(65535);

    // Connect to the forwarded local port and echo bytes through the mock gateway
    const sock = net.connect(localPort, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", reject);
      setTimeout(() => reject(new Error("TCP connect timed out")), 3_000);
    });

    sock.write("hello");
    const echoed = await new Promise<Buffer>((resolve, reject) => {
      sock.once("data", resolve);
      sock.once("error", reject);
      setTimeout(() => reject(new Error("no echo within 3s")), 3_000);
    });

    expect(echoed.toString()).toBe("hello");

    // Cleanup: close socket then kill CLI
    sock.destroy();
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
