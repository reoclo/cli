// tests/integration/tunnel-resilient-reconnect-e2e.test.ts
//
// End-to-end test for the resilient-reconnect path in `reoclo tunnel -R`.
//
// Scenario: the CLI connects, arms a reverse listener, then the mock gateway
// pushes `tunnel_interrupted` (runner blip) followed by `tunnel_resumed`.
// The CLI must re-send `tunnel_listen_open` to re-arm the listener WITHOUT
// the WS ever closing or the CLI process exiting.
//
// Mirrors tests/integration/tunnel-reverse-e2e.test.ts in structure.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ServerWebSocket } from "bun";
import { $ } from "bun";

const TENANT_ID = "00000000-0000-0000-0000-00000000aaaa";
const SERVER_ID = "00000000-0000-0000-0000-00000000eeee"; // UUID → resolveServer short-circuits
const TOKEN = "rk_t_tunnelRESILe2e";

// ---------------------------------------------------------------------------
// Mock backend: HTTP (auth/me) + WS gateway stub with resilient-reconnect support
// ---------------------------------------------------------------------------

interface ResilientBackend {
  url: string;
  directUrl: string;
  /** How many tunnel_listen_open frames have arrived from the CLI */
  listenOpenCount: number;
  /** How many WS connections the CLI has opened (should stay 1 for the whole session) */
  wsOpenCount: number;
  /** True if the backend currently holds a live CLI WS reference */
  cliWsAlive: () => boolean;
  /** Push any JSON frame directly to the CLI WS */
  pushToCli: (frame: object) => void;
  /** Resolves when listenOpenCount reaches n, or rejects after timeoutMs */
  waitForListenOpenCount: (n: number, timeoutMs: number) => Promise<void>;
  stop: () => Promise<void>;
}

function startResilientBackend(): ResilientBackend {
  let listenOpenCount = 0;
  let wsOpenCount = 0;
  let cliWs: ServerWebSocket<unknown> | null = null;
  const listenCountWaiters: Array<{ n: number; resolve: () => void; reject: (e: Error) => void }> =
    [];

  function notifyCountWaiters() {
    for (let i = listenCountWaiters.length - 1; i >= 0; i--) {
      const w = listenCountWaiters[i]!;
      if (listenOpenCount >= w.n) {
        w.resolve();
        listenCountWaiters.splice(i, 1);
      }
    }
  }

  const server = Bun.serve<unknown>({
    port: 0,

    fetch(req, srv) {
      const url = new URL(req.url);

      // 1. Auth probe for `reoclo login` and bootstrap
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
        const upgraded = srv.upgrade(req, { data: {} });
        if (upgraded) return undefined;
        return new Response("ws upgrade failed", { status: 500 });
      }

      return new Response("not found", { status: 404 });
    },

    websocket: {
      open(ws) {
        wsOpenCount++;
        cliWs = ws;
      },
      message(ws: ServerWebSocket<unknown>, raw: string | Buffer) {
        let msg: { type?: string; listen_id?: string };
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as typeof msg;
        } catch {
          return;
        }

        if (msg.type === "tunnel_listen_open") {
          listenOpenCount++;
          notifyCountWaiters();
          // Ack each listen_open with a fake bound port
          ws.send(
            JSON.stringify({ type: "tunnel_listen_opened", listen_id: msg.listen_id, port: 9998 }),
          );
          return;
        }
      },
      close() {
        cliWs = null;
      },
    },
  });

  const backend: ResilientBackend = {
    url: `http://localhost:${server.port}`,
    directUrl: `ws://localhost:${server.port}`,
    get listenOpenCount() {
      return listenOpenCount;
    },
    get wsOpenCount() {
      return wsOpenCount;
    },
    cliWsAlive() {
      return cliWs !== null;
    },
    pushToCli(frame) {
      if (cliWs) {
        cliWs.send(JSON.stringify(frame));
      }
    },
    waitForListenOpenCount(n, timeoutMs) {
      return new Promise<void>((resolve, reject) => {
        // Resolve immediately if count already reached
        if (listenOpenCount >= n) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          const idx = listenCountWaiters.findIndex((w) => w.n === n && w.resolve === resolveFn);
          if (idx !== -1) listenCountWaiters.splice(idx, 1);
          reject(
            new Error(
              `waitForListenOpenCount(${n}): timeout after ${timeoutMs}ms; current count=${listenOpenCount}`,
            ),
          );
        }, timeoutMs);
        const resolveFn = () => {
          clearTimeout(timer);
          resolve();
        };
        listenCountWaiters.push({ n, resolve: resolveFn, reject });
      });
    },
    stop: async () => {
      await server.stop(true);
    },
  };

  return backend;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let tmp: string;
let backend: ResilientBackend;
let cli: ChildProcessWithoutNullStreams;

beforeEach(async () => {
  backend = startResilientBackend();
  tmp = mkdtempSync(join(tmpdir(), "reoclo-tunnel-resilient-e2e-"));

  // Populate the profile so bootstrap() can read tenant_id.
  await $`bun run src/index.ts login --token ${TOKEN} --api ${backend.url} --no-keyring`
    .env({
      ...process.env,
      REOCLO_CONFIG_DIR: tmp,
      REOCLO_CACHE_DIR: join(tmp, "cache"),
    })
    .cwd(join(import.meta.dir, "../.."))
    .quiet();
});

afterEach(async () => {
  if (cli && cli.exitCode === null) {
    cli.kill("SIGINT");
    await new Promise<void>((resolve) => {
      cli.once("exit", resolve);
      setTimeout(() => {
        cli.kill("SIGKILL");
        resolve();
      }, 2_000);
    });
  }
  await backend.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe("reoclo tunnel -R — e2e resilient reconnect", () => {
  it(
    "re-arms the reverse listener on tunnel_interrupted → tunnel_resumed without closing the CLI WS",
    async () => {
      cli = spawn(
        "bun",
        ["run", "src/index.ts", "tunnel", SERVER_ID, "-R", "8080:127.0.0.1:3000"],
        {
          cwd: join(import.meta.dir, "../.."),
          env: {
            ...process.env,
            REOCLO_CONFIG_DIR: tmp,
            REOCLO_CACHE_DIR: join(tmp, "cache"),
            REOCLO_DIRECT_URL: backend.directUrl,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      let stderrBuf = "";
      cli.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      // Step 1: Wait for the CLI to print the -R bound line.
      // Proves the first tunnel_listen_open succeeded and the listener is armed.
      const printedBoundLine = await new Promise<boolean>((resolve, reject) => {
        let stdoutBuf = "";

        cli.stdout?.on("data", (chunk: Buffer) => {
          stdoutBuf += chunk.toString();
          if (/-R\s+\S+:\d+\s+→\s+127\.0\.0\.1:\d+\s+\(tcp\)/.test(stdoutBuf)) {
            resolve(true);
          }
        });

        cli.on("error", reject);
        cli.on("exit", (code) => {
          reject(
            new Error(`CLI exited (code ${code}) before printing the -R bound line. stderr: ${stderrBuf}`),
          );
        });

        setTimeout(
          () =>
            reject(
              new Error(
                `CLI did not print -R bound line within 8s. stderr: ${stderrBuf}`,
              ),
            ),
          8_000,
        );
      });

      expect(printedBoundLine).toBe(true);

      // Step 2: First listen_open arrived.
      expect(backend.listenOpenCount).toBe(1);

      // Step 3: Simulate a runner blip — push tunnel_interrupted.
      // The CLI should set status → "reconnecting" but keep the WS open.
      backend.pushToCli({ type: "tunnel_interrupted", reason: "runner_disconnected" });

      // Deliberate settle-time: give the CLI a chance to process the frame before
      // asserting exitCode. 300ms provides CI headroom without needing a stderr-wait.
      await new Promise<void>((r) => setTimeout(r, 300));

      // Step 4: Assert the CLI WS is still open — process still alive.
      expect(cli.exitCode).toBeNull();

      // Step 5: Push tunnel_resumed. The CLI must re-send tunnel_listen_open
      // to re-arm its reverse listeners (rearmReverseListeners).
      backend.pushToCli({ type: "tunnel_resumed" });

      // Step 6: Wait until the second tunnel_listen_open arrives.
      await backend.waitForListenOpenCount(2, 5_000);

      // Step 7: Final assertions.
      expect(backend.listenOpenCount).toBe(2);
      // CLI process is still alive — WS never closed, no exit.
      expect(cli.exitCode).toBeNull();

      // CORE GUARANTEE: the CLI WS was never closed/reopened across interrupt→resume.
      // Exactly one WS connection should have been established for the whole session.
      expect(backend.wsOpenCount).toBe(1);
      // The backend still holds a live cliWs reference (close() was never fired).
      expect(backend.cliWsAlive()).toBe(true);
    },
    20_000, // generous timeout for bun process startup
  );
});
