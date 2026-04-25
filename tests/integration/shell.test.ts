// tests/integration/shell.test.ts
//
// Spins up a small Bun WebSocket server that pretends to be the rbase
// /mcp/ws/terminal/{server_id} endpoint, then drives `reoclo shell` against
// it via `bun run src/index.ts shell --allow-no-tty`. Validates handshake,
// subprotocol echo, message round-trip, and exit-code propagation.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";

const TENANT_ID = "00000000-0000-0000-0000-00000000aaaa";
const SERVER_ID = "00000000-0000-0000-0000-00000000bbbb";
const TOKEN = "rk_t_shelltest";

interface ShellGateway {
  url: string;
  stop: () => void;
  /** Override what the server does on a WS connection (default: ready then exit 0). */
  onConnection: (ws: ServerWebSocket<{ subprotocol: string }>) => void | Promise<void>;
  /** Captures the Sec-WebSocket-Protocol header sent by the client. */
  lastRequestedSubprotocol: string | null;
}

function startShellGateway(): ShellGateway {
  const fixture: ShellGateway = {
    url: "",
    stop: () => {},
    onConnection: (ws) => {
      // Default: announce ready, send a line of stdout, exit 0.
      ws.send(JSON.stringify({ type: "ready" }));
      ws.sendBinary(new TextEncoder().encode("welcome\n"));
      ws.send(JSON.stringify({ type: "exited", exit_code: 0 }));
    },
    lastRequestedSubprotocol: null,
  };

  const server = Bun.serve<{ subprotocol: string }>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);

      // /mcp/auth/me — used by `reoclo login` to validate the key.
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

      // /mcp/ws/terminal/{server_id} — the shell endpoint.
      if (url.pathname === `/mcp/ws/terminal/${SERVER_ID}`) {
        const requested = req.headers.get("sec-websocket-protocol") ?? "";
        fixture.lastRequestedSubprotocol = requested;
        // Echo the requested subprotocol back exactly (RFC 6455 requirement).
        const upgraded = srv.upgrade(req, {
          data: { subprotocol: requested },
          headers: { "Sec-WebSocket-Protocol": requested },
        });
        if (upgraded) return undefined;
        return new Response("ws upgrade failed", { status: 500 });
      }

      return new Response("not found", { status: 404 });
    },
    websocket: {
      async open(ws) {
        await fixture.onConnection(ws);
      },
      message() {
        // Default behaviour ignores client input; tests can override onConnection.
      },
    },
  });

  fixture.url = `http://localhost:${server.port}`;
  fixture.stop = () => {
    void server.stop(true);
  };
  return fixture;
}

let tmp: string;
let gw: ShellGateway;

beforeEach(async () => {
  gw = startShellGateway();
  tmp = mkdtempSync(join(tmpdir(), "reoclo-shell-"));
  await $`bun run src/index.ts login --token ${TOKEN} --api ${gw.url} --no-keyring`
    .env({
      ...process.env,
      REOCLO_CONFIG_DIR: tmp,
      REOCLO_CACHE_DIR: join(tmp, "cache"),
    })
    .quiet();
});

afterEach(() => {
  gw.stop();
});

const baseEnv = (): Record<string, string> => ({
  ...process.env,
  REOCLO_CONFIG_DIR: tmp,
  REOCLO_CACHE_DIR: join(tmp, "cache"),
});

test("shell happy-path: receives ready, prints stdout, exits 0", async () => {
  const r = await $`bun run src/index.ts shell ${SERVER_ID} --allow-no-tty`
    .env(baseEnv())
    .quiet();
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain("welcome");
});

test("shell sends a properly-versioned api-key subprotocol", async () => {
  await $`bun run src/index.ts shell ${SERVER_ID} --allow-no-tty`.env(baseEnv()).quiet();
  expect(gw.lastRequestedSubprotocol).not.toBeNull();
  expect(gw.lastRequestedSubprotocol!.startsWith("reoclo.api-key.v1.")).toBe(true);
  // The encoded portion is base64url(TOKEN) — verify roundtrip.
  const encoded = gw.lastRequestedSubprotocol!.split(".").pop() ?? "";
  // Re-pad and decode to check it matches the token.
  const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
  const decoded = Buffer.from(
    padded.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
  expect(decoded).toBe(TOKEN);
});

test("shell propagates the remote exit code", async () => {
  gw.onConnection = (ws) => {
    ws.send(JSON.stringify({ type: "ready" }));
    ws.send(JSON.stringify({ type: "exited", exit_code: 42 }));
  };
  const r = await $`bun run src/index.ts shell ${SERVER_ID} --allow-no-tty`
    .env(baseEnv())
    .nothrow()
    .quiet();
  expect(r.exitCode).toBe(42);
});

test("shell exits 2 when stdout is a TTY but stdin is not (default)", async () => {
  // bun run inherits the parent's stdio in tests, which is non-TTY. With the
  // default check ON, the command should refuse to run.
  const r = await $`bun run src/index.ts shell ${SERVER_ID}`
    .env(baseEnv())
    .nothrow()
    .quiet();
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("interactive TTY");
});
