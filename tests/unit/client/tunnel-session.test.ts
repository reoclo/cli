import { describe, it, expect, afterEach, spyOn } from "bun:test";
import net from "node:net";
import dgram from "node:dgram";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { TunnelSession } from "../../../src/client/tunnel-session";

interface MockGateway {
  url: string;
  /** Gracefully shut down (only call after all CLI WS connections are closed) */
  stop: () => Promise<void>;
  /** Force-drop all active WS connections without waiting */
  dropConnections: () => void;
  /** Send a proper WS close frame from the server side — causes the CLI's close event to fire.
   *  Optionally include a WS close code (e.g. 4502 for "Runner connection failed") and reason. */
  closeActiveConnection: (code?: number, reason?: string) => void;
  /** Frames received from the CLI, in order */
  received: object[];
  /** Send a frame to whatever CLI is currently connected */
  sendToCli: (msg: object) => void;
  /** Called for every frame received from the CLI (optional override) */
  onClientFrame?: (msg: Record<string, unknown>) => void;
  /** Upgrade-request headers captured for every WS connection, in order (index 0 = first
   *  connect, index 1 = first reconnect, etc.) — lets reconnect tests assert on the token
   *  the CLI presented on THAT specific connection. */
  upgradeHeaders: Record<string, string | string[] | undefined>[];
}

interface MockGatewayOpts {
  echoData?: boolean;
  /** Called when a tunnel_listen_open frame arrives from the CLI */
  onListenOpen?: (msg: Record<string, unknown>, ws: WebSocket) => void;
}

async function startMockGateway(opts: MockGatewayOpts = {}): Promise<MockGateway> {
  const wss = new WebSocketServer({ port: 0 });
  const received: object[] = [];
  const upgradeHeaders: Record<string, string | string[] | undefined>[] = [];
  let activeWs: WebSocket | null = null;
  let onClientFrame: ((msg: Record<string, unknown>) => void) | undefined;

  wss.on("connection", (ws, req) => {
    upgradeHeaders.push(req.headers);
    activeWs = ws;
    ws.on("error", () => { /* swallow errors on forced close */ });
    ws.on("message", (raw) => {
      const msg = JSON.parse(
        Array.isArray(raw)
          ? Buffer.concat(raw).toString()
          : Buffer.isBuffer(raw)
            ? raw.toString()
            : Buffer.from(raw).toString(),
      ) as Record<string, unknown>;
      received.push(msg);
      onClientFrame?.(msg);
      if (msg.type === "tunnel_open") {
        ws.send(JSON.stringify({ type: "tunnel_opened", stream_id: msg.stream_id }));
      }
      if (msg.type === "tunnel_listen_open" && opts.onListenOpen) {
        opts.onListenOpen(msg, ws);
      }
      if (msg.type === "tunnel_data" && opts.echoData) {
        ws.send(JSON.stringify({ type: "tunnel_data", stream_id: msg.stream_id, data: msg.data }));
      }
    });
    ws.on("close", () => {
      if (activeWs === ws) activeWs = null;
    });
  });
  await new Promise<void>((r) => wss.on("listening", r));
  const port = (wss.address() as { port: number }).port;

  const gw: MockGateway = {
    url: `ws://127.0.0.1:${port}`,
    received,
    upgradeHeaders,
    sendToCli: (msg) => activeWs?.send(JSON.stringify(msg)),
    dropConnections: () => {
      for (const client of wss.clients) {
        (client as unknown as { _socket?: { destroy(): void } })._socket?.destroy();
      }
    },
    closeActiveConnection: (code, reason) => {
      // Sends a proper WS close frame so the CLI-side WS fires its "close" event.
      // Forwards (code, reason) when provided so fatal-code tests can simulate
      // gateway-level rejections like 4502 "Runner connection failed".
      if (code !== undefined) {
        activeWs?.close(code, reason);
      } else {
        activeWs?.close();
      }
    },
    stop: () =>
      new Promise<void>((r) => {
        for (const client of wss.clients) {
          (client as unknown as { _socket?: { destroy(): void } })._socket?.destroy();
        }
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          r();
        };
        // Bun v1.3.11: wss.close()'s callback is unreliable — it can fail to
        // fire when clients=0, and also in a race where a just-destroyed
        // client (e.g. from a completed reconnect test) hasn't yet been
        // pruned from wss.clients. Race it against a short timeout so a
        // flaky callback never wedges a test's afterEach.
        const timer = setTimeout(finish, 300);
        (timer as unknown as { unref?: () => void }).unref?.();
        wss.close(() => {
          clearTimeout(timer);
          finish();
        });
      }),
    get onClientFrame() { return onClientFrame; },
    set onClientFrame(fn) { onClientFrame = fn; },
  };
  return gw;
}

/** Build a syntactically-valid (unsigned) JWT carrying only an `exp` claim,
 *  so jwtExp() can decode it for the renewal-timer tests. */
function makeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("TunnelSession — forward TCP", () => {
  let gw: MockGateway;
  afterEach(async () => {
    await gw?.stop();
  });

  it("opens a local TCP listener and sends tunnel_open to gateway on accepted connection", async () => {
    gw = await startMockGateway();
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      forwards: [
        {
          localBind: "127.0.0.1",
          localPort: 0,
          remoteHost: "10.0.0.1",
          remotePort: 5432,
          proto: "tcp",
        },
      ],
    });
    const ready = await session.start();
    const localPort = ready.forwards[0]!.boundPort;

    const client = net.connect(localPort, "127.0.0.1");
    await new Promise((r) => client.once("connect", r));

    // Wait for tunnel_open to land
    const deadline = Date.now() + 500;
    while (
      Date.now() < deadline &&
      !gw.received.some((m: object) => (m as { type?: string }).type === "tunnel_open")
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const open = gw.received.find(
      (m: object) => (m as { type?: string }).type === "tunnel_open",
    ) as { proto: string; host: string; port: number } | undefined;
    expect(open).toBeDefined();
    expect(open!.proto).toBe("tcp");
    expect(open!.host).toBe("10.0.0.1");
    expect(open!.port).toBe(5432);

    client.destroy();
    await session.stop();
  });

  it("echoes bytes through the gateway (data is base64'd both ways)", async () => {
    gw = await startMockGateway({ echoData: true });
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      forwards: [
        { localBind: "127.0.0.1", localPort: 0, remoteHost: "x", remotePort: 1, proto: "tcp" },
      ],
    });
    const ready = await session.start();
    const localPort = ready.forwards[0]!.boundPort;

    const client = net.connect(localPort, "127.0.0.1");
    await new Promise((r) => client.once("connect", r));
    client.write("hello");
    const echoed = await new Promise<Buffer>((r) => client.once("data", r));
    expect(echoed.toString()).toBe("hello");

    client.destroy();
    await session.stop();
  });

  it("on local socket close, sends tunnel_close to gateway", async () => {
    gw = await startMockGateway();
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      forwards: [
        { localBind: "127.0.0.1", localPort: 0, remoteHost: "x", remotePort: 1, proto: "tcp" },
      ],
    });
    const ready = await session.start();

    const client = net.connect(ready.forwards[0]!.boundPort, "127.0.0.1");
    await new Promise((r) => client.once("connect", r));
    client.destroy();

    const deadline = Date.now() + 500;
    while (
      Date.now() < deadline &&
      !gw.received.some((m: object) => (m as { type?: string }).type === "tunnel_close")
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(
      gw.received.some((m: object) => (m as { type?: string }).type === "tunnel_close"),
    ).toBe(true);
    await session.stop();
  });
});

describe("TunnelSession — forward UDP", () => {
  let gw: MockGateway;
  afterEach(async () => {
    await gw?.stop();
  });

  it("forwards UDP datagrams and routes replies back to the original peer", async () => {
    gw = await startMockGateway({ echoData: true });
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      forwards: [
        { localBind: "127.0.0.1", localPort: 0, remoteHost: "x", remotePort: 1, proto: "udp" },
      ],
    });
    const ready = await session.start();
    const localPort = ready.forwards[0]!.boundPort;

    const peer = dgram.createSocket("udp4");
    await new Promise<void>((r) => peer.bind(0, "127.0.0.1", () => r()));
    peer.send(Buffer.from("ping"), localPort, "127.0.0.1");
    const reply = await new Promise<Buffer>((r) => peer.once("message", r));
    expect(reply.toString()).toBe("ping");

    peer.close();
    await session.stop();
  });
});

describe("TunnelSession — reconnect", () => {
  it("transparently reconnects when gateway WS drops, listener stays up", async () => {
    const gw = await startMockGateway();
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      forwards: [
        { localBind: "127.0.0.1", localPort: 0, remoteHost: "x", remotePort: 1, proto: "tcp" },
      ],
      reconnectDeadlineMs: 10_000,
    });
    const ready = await session.start();
    const localPort = ready.forwards[0]!.boundPort;

    // Force-drop the active WS connection (simulates a network drop).
    // The gateway WSS stays up so the CLI can reconnect.
    gw.dropConnections();

    // Give the drop a tick to propagate
    await new Promise((r) => setTimeout(r, 20));

    // The listener should still be reachable locally (this is what "transparent" means)
    const probe = net.connect(localPort, "127.0.0.1");
    const localConnectable = await new Promise<boolean>((r) => {
      probe.once("connect", () => {
        probe.destroy();
        r(true);
      });
      probe.once("error", () => r(false));
    });
    expect(localConnectable).toBe(true);

    // Stop session first (closes CLI WS), then stop gateway
    await session.stop();
    await gw.stop();
  });

  it("local TCP listener accepts new connections after WS drops", async () => {
    const gw = await startMockGateway();
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      forwards: [
        { localBind: "127.0.0.1", localPort: 0, remoteHost: "x", remotePort: 1, proto: "tcp" },
      ],
      reconnectDeadlineMs: 30_000,
    });
    const ready = await session.start();
    const localPort = ready.forwards[0]!.boundPort;

    // Force gateway WSS close (the WS-server side) but DON'T stop the mock — server still binds
    gw.dropConnections();

    // Wait briefly for the session to enter reconnecting state
    await new Promise((r) => setTimeout(r, 100));

    // Local listener should still accept new connections (they queue while reconnect attempts)
    const probe = net.connect(localPort, "127.0.0.1");
    const connected = await new Promise<boolean>((r) => {
      probe.once("connect", () => {
        probe.destroy();
        r(true);
      });
      probe.once("error", () => r(false));
      setTimeout(() => r(false), 500);
    });
    expect(connected).toBe(true);

    await session.stop();
    await gw.stop();
  });
});

describe("TunnelSession — reverse TCP", () => {
  let gw: MockGateway;
  afterEach(async () => { await gw?.stop(); });

  it("sends tunnel_listen_open and awaits tunnel_listen_opened, returning bound port", async () => {
    gw = await startMockGateway({
      onListenOpen: (msg, ws) => {
        ws.send(JSON.stringify({ type: "tunnel_listen_opened", listen_id: msg.listen_id, port: 9999 }));
      },
    });
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      reverses: [{ remoteBind: "127.0.0.1", remotePort: 8080, localHost: "127.0.0.1", localPort: 3000, proto: "tcp" }],
    });
    const ready = await session.start();
    expect(ready.reverses).toEqual([{ boundPort: 9999 }]);
    await session.stop();
  });

  it("on inbound tunnel_open from gateway, dials local target and pipes bytes", async () => {
    // Local target — echo server
    const target = net.createServer((sock) => sock.pipe(sock));
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
    const targetPort = (target.address() as net.AddressInfo).port;

    gw = await startMockGateway({
      onListenOpen: (msg, ws) => {
        ws.send(JSON.stringify({ type: "tunnel_listen_opened", listen_id: msg.listen_id, port: 99 }));
        // Simulate an inbound connection a moment later
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: "tunnel_open",
            stream_id: "s-rev-1",
            proto: "tcp",
            host: "1.2.3.4",
            port: 12345,
            listen_id: msg.listen_id,
          }));
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: "tunnel_data",
              stream_id: "s-rev-1",
              data: Buffer.from("hello").toString("base64"),
            }));
          }, 30);
        }, 30);
      },
    });

    const echoes: string[] = [];
    gw.onClientFrame = (msg) => {
      if (msg.type === "tunnel_data" && msg.stream_id === "s-rev-1") {
        echoes.push(msg.data as string);
      }
    };

    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      reverses: [{ remoteBind: "127.0.0.1", remotePort: 99, localHost: "127.0.0.1", localPort: targetPort, proto: "tcp" }],
    });
    await session.start();

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && echoes.length === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(echoes.length).toBeGreaterThan(0);
    expect(Buffer.from(echoes[0]!, "base64").toString()).toBe("hello");

    await session.stop();
    await new Promise<void>((r) => target.close(() => r()));
  });

  it("on tunnel_listen_error from gateway, start() rejects", async () => {
    gw = await startMockGateway({
      onListenOpen: (msg, ws) => {
        ws.send(JSON.stringify({ type: "tunnel_listen_error", listen_id: msg.listen_id, error: "port in use" }));
      },
    });
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      reverses: [{ remoteBind: "127.0.0.1", remotePort: 8080, localHost: "x", localPort: 3000, proto: "tcp" }],
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() returns a Promise at runtime but is typed as void
    await expect(session.start()).rejects.toThrow(/port in use/);
    // Clean up the live WS opened during start() before afterEach destroys the gateway
    await session.stop();
  });

  it("on inbound tunnel_open for UDP-reverse, sends datagram to local target and pipes reply back", async () => {
    // Local UDP echo target
    const target = dgram.createSocket("udp4");
    target.on("message", (buf, rinfo) => target.send(buf, rinfo.port, rinfo.address));
    await new Promise<void>((r) => target.bind(0, "127.0.0.1", () => r()));
    const targetPort = (target.address() as { port: number }).port;

    gw = await startMockGateway({
      onListenOpen: (msg, ws) => {
        ws.send(JSON.stringify({ type: "tunnel_listen_opened", listen_id: msg.listen_id, port: 100 }));
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: "tunnel_open",
            stream_id: "s-udp-rev",
            proto: "udp",
            host: "1.2.3.4",
            port: 99,
            listen_id: msg.listen_id,
          }));
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: "tunnel_data",
              stream_id: "s-udp-rev",
              data: Buffer.from("ping").toString("base64"),
            }));
          }, 30);
        }, 30);
      },
    });

    const echoes: string[] = [];
    gw.onClientFrame = (msg) => {
      if (msg.type === "tunnel_data" && msg.stream_id === "s-udp-rev") {
        echoes.push(msg.data as string);
      }
    };

    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      reverses: [{ remoteBind: "127.0.0.1", remotePort: 100, localHost: "127.0.0.1", localPort: targetPort, proto: "udp" }],
    });
    await session.start();

    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && echoes.length === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(echoes.length).toBeGreaterThan(0);
    expect(Buffer.from(echoes[0]!, "base64").toString()).toBe("ping");

    await session.stop();
    await new Promise<void>((r) => target.close(() => r()));
  });

  it("stop() sends tunnel_listen_close per active reverse listener", async () => {
    const closeFrames: string[] = [];
    gw = await startMockGateway({
      onListenOpen: (msg, ws) => {
        ws.send(JSON.stringify({ type: "tunnel_listen_opened", listen_id: msg.listen_id, port: 100 }));
      },
    });
    gw.onClientFrame = (msg) => {
      if (msg.type === "tunnel_listen_close") {
        closeFrames.push(msg.listen_id as string);
      }
    };
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      reverses: [{ remoteBind: "127.0.0.1", remotePort: 100, localHost: "x", localPort: 1, proto: "tcp" }],
    });
    await session.start();
    await session.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(closeFrames.length).toBe(1);
  });
});

describe("TunnelSession — interrupt/resume", () => {
  let gw: MockGateway;
  afterEach(async () => { await gw?.stop(); });

  it("tunnel_interrupted sets status 'reconnecting' and WS stays open", async () => {
    const statuses: string[] = [];
    gw = await startMockGateway();
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      onStatus: (s) => statuses.push(s),
    });
    await session.start();

    gw.sendToCli({ type: "tunnel_interrupted", reason: "runner_disconnected" });

    // Wait for the status to propagate
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && !statuses.includes("reconnecting")) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(statuses).toContain("reconnecting");
    // Verify session WS is still OPEN (not closed by the CLI)
    // The mock gateway still has an active connection — it would be null if CLI closed
    expect((gw as { received: object[] }).received.some(
      (m: object) => (m as { type?: string }).type === "close"
    )).toBe(false);

    await session.stop();
  });

  it("tunnel_resumed re-sends tunnel_listen_open for active reverse listeners and sets status 'active'", async () => {
    const statuses: string[] = [];
    let listenOpenCount = 0;

    gw = await startMockGateway({
      onListenOpen: (msg, ws) => {
        listenOpenCount++;
        ws.send(JSON.stringify({ type: "tunnel_listen_opened", listen_id: msg.listen_id, port: 7777 }));
      },
    });

    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      reverses: [{ remoteBind: "127.0.0.1", remotePort: 7777, localHost: "127.0.0.1", localPort: 3000, proto: "tcp" }],
      onStatus: (s) => statuses.push(s),
    });
    await session.start();
    expect(listenOpenCount).toBe(1);

    // Simulate gateway interrupt then resume
    gw.sendToCli({ type: "tunnel_interrupted", reason: "runner_disconnected" });
    await new Promise((r) => setTimeout(r, 20));
    gw.sendToCli({ type: "tunnel_resumed" });

    // Wait for the second tunnel_listen_open
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && listenOpenCount < 2) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(listenOpenCount).toBe(2);
    expect(statuses).toContain("active");
    // The last status after resume should be "active"
    expect(statuses[statuses.length - 1]).toBe("active");

    await session.stop();
  });

  it("tunnel_resumed with no reverse listeners is a clean no-op", async () => {
    const statuses: string[] = [];
    gw = await startMockGateway();
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      forwards: [{ localBind: "127.0.0.1", localPort: 0, remoteHost: "x", remotePort: 1, proto: "tcp" }],
      onStatus: (s) => statuses.push(s),
    });
    await session.start();

    // No crash expected — just status transitions
    gw.sendToCli({ type: "tunnel_interrupted", reason: "runner_disconnected" });
    await new Promise((r) => setTimeout(r, 20));
    gw.sendToCli({ type: "tunnel_resumed" });
    await new Promise((r) => setTimeout(r, 50));

    expect(statuses).toContain("reconnecting");
    expect(statuses[statuses.length - 1]).toBe("active");

    await session.stop();
  });

  it("tunnel_interrupted does not close the CLI WS", async () => {
    gw = await startMockGateway();
    let wsCloseCount = 0;
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      onStatus: (s) => { if (s === "closed") wsCloseCount++; },
    });
    await session.start();

    gw.sendToCli({ type: "tunnel_interrupted", reason: "runner_disconnected" });
    await new Promise((r) => setTimeout(r, 100));

    // Session should NOT have emitted "closed" — the WS is still open
    expect(wsCloseCount).toBe(0);
    // Verify the CLI hasn't sent any "close" frames to the gateway
    const closeSent = gw.received.some(
      (m: object) => (m as { type?: string }).type === "tunnel_close"
    );
    expect(closeSent).toBe(false);

    await session.stop();
  });

  it("clears the interrupted flag when the CLI's own WS drops and reconnects", async () => {
    // Sequence: session starts → gateway sends tunnel_interrupted (interrupted=true, accept-guard
    // active) → gateway sends a proper WS close frame → onWsClose fires → interrupted cleared.
    // Key invariant: after the WS close, the accept-guard MUST NOT destroy new local TCP
    // connections — even before the reconnect backoff timer fires.
    //
    // We set reconnectDeadlineMs=0 so the session immediately gives up reconnecting after the
    // WS close, which prevents the reconnect timer from creating a new WS connection that would
    // interfere with the afterEach gw.stop() teardown.
    gw = await startMockGateway();
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      forwards: [{ localBind: "127.0.0.1", localPort: 0, remoteHost: "x", remotePort: 1, proto: "tcp" }],
      reconnectDeadlineMs: 10_000,
    });
    const ready = await session.start();
    const localPort = ready.forwards[0]!.boundPort;

    // Put the session into interrupted state — accept-guard now active
    gw.sendToCli({ type: "tunnel_interrupted", reason: "runner_disconnected" });
    await new Promise((r) => setTimeout(r, 30));

    // Verify guard IS active: a connection attempt should be immediately destroyed
    const guardProbe = net.connect(localPort, "127.0.0.1");
    const guardResult = await new Promise<"closed" | "survived">((r) => {
      guardProbe.once("close", () => r("closed"));
      guardProbe.once("error", () => r("closed"));
      setTimeout(() => r("survived"), 200);
    });
    guardProbe.destroy();
    expect(guardResult).toBe("closed"); // accept-guard is working

    // Close the active WS with a proper close frame (ws.close()) — this triggers onWsClose()
    // which clears this.interrupted = false, lifting the accept-guard.
    // reconnectDeadlineMs=0 ensures tryAgain() immediately gives up (deadline already passed)
    // so no reconnect timer is set, keeping cleanup deterministic.
    gw.closeActiveConnection();
    // Wait for the WS close event to propagate through the event loop on both sides.
    await new Promise((r) => setTimeout(r, 100));

    // Now the accept-guard MUST be cleared. A new probe should survive (not be destroyed).
    // Note: tunnel_open cannot reach the gateway (WS is closed) but the socket is not destroyed.
    const probe = net.connect(localPort, "127.0.0.1");
    const probeResult = await new Promise<"closed" | "survived">((r) => {
      probe.once("close", () => r("closed"));
      probe.once("error", () => r("closed"));
      setTimeout(() => r("survived"), 200);
    });
    probe.destroy();
    await session.stop();

    // Accept-guard cleared — probe should survive (not be destroyed by onLocalTcpAccept guard)
    expect(probeResult).toBe("survived");
  });

  it("while interrupted, new local TCP connections are destroyed fast (accept-guard)", async () => {
    gw = await startMockGateway();
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      forwards: [{ localBind: "127.0.0.1", localPort: 0, remoteHost: "x", remotePort: 1, proto: "tcp" }],
    });
    const ready = await session.start();
    const localPort = ready.forwards[0]!.boundPort;

    // Interrupt the session
    gw.sendToCli({ type: "tunnel_interrupted", reason: "runner_disconnected" });
    await new Promise((r) => setTimeout(r, 30));

    const tunnelOpensBefore = gw.received.filter(
      (m: object) => (m as { type?: string }).type === "tunnel_open"
    ).length;

    // Try to connect — should be destroyed without a tunnel_open being sent
    const probe = net.connect(localPort, "127.0.0.1");
    const result = await new Promise<"closed" | "connected">((r) => {
      probe.once("close", () => r("closed"));
      probe.once("error", () => r("closed"));
      setTimeout(() => r("connected"), 200);
    });

    // The socket should be closed fast (destroyed by accept-guard)
    expect(result).toBe("closed");

    const tunnelOpensAfter = gw.received.filter(
      (m: object) => (m as { type?: string }).type === "tunnel_open"
    ).length;
    expect(tunnelOpensAfter).toBe(tunnelOpensBefore);

    await session.stop();
  });
});

describe("TunnelSession — fatal close codes", () => {
  it("emits 'failed' status with reason on WS close 4502 (Runner connection failed) and does not reconnect", async () => {
    const gw = await startMockGateway();
    const statuses: { s: string; reason?: string }[] = [];
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      forwards: [
        { localBind: "127.0.0.1", localPort: 0, remoteHost: "x", remotePort: 1, proto: "tcp" },
      ],
      reconnectDeadlineMs: 30_000,
      onStatus: (s, reason) => {
        statuses.push({ s, reason });
      },
    });
    await session.start();

    // Gateway sends a fatal close code (4502 = runner connection failed)
    gw.closeActiveConnection(4502, "Runner connection failed");

    // Wait long enough that a reconnect would have been attempted (BACKOFF_BASE_MS = 500ms)
    await new Promise((r) => setTimeout(r, 800));

    // Must have emitted 'failed' with the reason
    const failed = statuses.find((x) => x.s === "failed");
    expect(failed).toBeDefined();
    expect(failed!.reason).toContain("Runner connection failed");

    // Must NOT have transitioned to 'reconnecting' after the fatal close
    const failedIdx = statuses.findIndex((x) => x.s === "failed");
    const reconnectAfter = statuses.slice(failedIdx + 1).some((x) => x.s === "reconnecting");
    expect(reconnectAfter).toBe(false);

    // Must NOT have re-opened a second WS connection to the gateway
    expect(gw.received.filter(
      (m: object) => (m as { type?: string }).type === "tunnel_open",
    ).length).toBe(0);

    await session.stop();
    await gw.stop();
  });

  it("transitions through 'reconnecting' on transient WS close 1006 (abnormal closure)", async () => {
    const gw = await startMockGateway();
    const statuses: { s: string; reason?: string }[] = [];
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      forwards: [
        { localBind: "127.0.0.1", localPort: 0, remoteHost: "x", remotePort: 1, proto: "tcp" },
      ],
      reconnectDeadlineMs: 10_000,
      onStatus: (s, reason) => {
        statuses.push({ s, reason });
      },
    });
    await session.start();

    // Close with code 1011 (Server error / idle reaper) — transient, retryable
    gw.closeActiveConnection(1011, "transient");

    // Wait for the reconnect status to be emitted
    await new Promise((r) => setTimeout(r, 200));

    expect(statuses.some((x) => x.s === "reconnecting")).toBe(true);
    expect(statuses.some((x) => x.s === "failed")).toBe(false);

    await session.stop();
    await gw.stop();
  });
});

describe("TunnelSession — updateToken", () => {
  it("changes the token used on the NEXT (reconnect) connection", async () => {
    const gw = await startMockGateway();
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "t1",
      forwards: [
        { localBind: "127.0.0.1", localPort: 0, remoteHost: "x", remotePort: 1, proto: "tcp" },
      ],
      reconnectDeadlineMs: 10_000,
    });
    await session.start();
    expect(gw.upgradeHeaders[0]?.authorization).toBe("Bearer t1");

    session.updateToken("t2");

    // 4408 is NOT in FATAL_CLOSE_CODES → retryable, so the CLI reconnects.
    gw.closeActiveConnection(4408, "idle timeout");

    // Wait for the reconnect's upgrade request to land (BACKOFF_BASE_MS = 500ms).
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && gw.upgradeHeaders.length < 2) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(gw.upgradeHeaders.length).toBeGreaterThanOrEqual(2);
    expect(gw.upgradeHeaders[1]?.authorization).toBe("Bearer t2");

    await session.stop();
    await gw.stop();
  });
});

describe("TunnelSession — proactive token renewal", () => {
  let gw: MockGateway;
  afterEach(async () => { await gw?.stop(); });

  it("renewNow() refreshes, adopts the token, and sends token_renew upstream", async () => {
    gw = await startMockGateway();
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "t1",
      refresh: (_currentToken: string) => Promise.resolve("t2"),
    });
    await session.start();

    await (session as unknown as { renewNow: () => Promise<void> }).renewNow();

    // ws.send() writes to the socket asynchronously; wait for the frame to
    // actually land at the mock gateway rather than asserting immediately.
    const deadline = Date.now() + 1000;
    while (
      Date.now() < deadline &&
      !gw.received.some((m: object) => (m as { type?: string }).type === "token_renew")
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(gw.received).toContainEqual({ type: "token_renew", token: "t2" });
    expect((session as unknown as { opts: { token: string } }).opts.token).toBe("t2");

    await session.stop();
  });

  it("renewNow() with a null refresh result does not send a frame or change the token", async () => {
    gw = await startMockGateway();
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "t1",
      refresh: (_currentToken: string) => Promise.resolve(null),
    });
    await session.start();

    await (session as unknown as { renewNow: () => Promise<void> }).renewNow();

    expect(
      gw.received.some((m: object) => (m as { type?: string }).type === "token_renew"),
    ).toBe(false);
    expect((session as unknown as { opts: { token: string } }).opts.token).toBe("t1");

    await session.stop();
  });

  it("renewNow() calls refresh with the session's CURRENT token on every cycle (multi-cycle rotation)", async () => {
    // Regression test for the Plan C Critical: wiring that pins a snapshot of
    // the token taken once at construction (e.g. `() => ctx.refresh!(ctx.token)`
    // in src/commands/tunnel.ts) means cycle 2+ calls refresh with the SAME
    // stale token forever, even though the session's live token has already
    // rotated. refreshSession()'s double-check (src/auth/refresh.ts) mints a
    // new token only while the stored token still equals the argument it was
    // called with, so a pinned argument makes every renewal after the first
    // short-circuit: no new mint, no exp advance, and (via the re-arm floor
    // added in this same fix) would otherwise busy-spin.
    //
    // TunnelSession itself must thread `this.opts.token` — the session's own
    // live, continuously-updated token — into `refresh()` on every call. This
    // fails against the pre-fix renewNow(), which called `this.opts.refresh()`
    // with no argument at all.
    gw = await startMockGateway();
    const calledWith: string[] = [];
    const nextTokens = ["t1", "t2", "t3"];
    let call = 0;
    const refresh = (currentToken: string): Promise<string | null> => {
      calledWith.push(currentToken);
      return Promise.resolve(nextTokens[call++] ?? null);
    };
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "t0",
      refresh,
    });
    await session.start();

    const renewNow = (session as unknown as { renewNow: () => Promise<void> }).renewNow.bind(
      session,
    );

    await renewNow(); // cycle 1: session token is "t0" → refresh("t0") → adopts "t1"
    await renewNow(); // cycle 2: session token is now "t1" → refresh("t1") → adopts "t2"

    // Cycle 2 MUST be called with "t1" (the live, rotated token) — NOT "t0"
    // again. A pinned-token wiring would record ["t0", "t0"] here.
    expect(calledWith).toEqual(["t0", "t1"]);
    expect((session as unknown as { opts: { token: string } }).opts.token).toBe("t2");

    await session.stop();
  });

  it("re-arm floor: a null refresh result re-arms at the coarse skew backoff, not ~0ms", async () => {
    // Safety net for the same bug class as the multi-cycle test above: if a
    // renewal ever fails to advance the token's exp while the token is still
    // inside the skew window, re-arming from the normal computed delay would
    // read the same (still near-expiry) exp and yield ~0ms — a busy-spin.
    // Seed a token that's ALREADY inside the skew window (well under
    // RENEW_SKEW_SECONDS=120s out) so the un-floored computation would fire
    // ~immediately; the floor must override that with the coarse backoff.
    gw = await startMockGateway();
    const nearExpirySeconds = Math.floor(Date.now() / 1000) + 5;
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: makeJwt(nearExpirySeconds),
      refresh: (_currentToken: string) => Promise.resolve(null),
    });
    await session.start();

    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    try {
      await (session as unknown as { renewNow: () => Promise<void> }).renewNow();
    } finally {
      // The re-arm inside renewNow()'s finally block is the LAST setTimeout
      // call made during this synchronous-after-await window.
      const lastCall = setTimeoutSpy.mock.calls.at(-1);
      setTimeoutSpy.mockRestore();
      expect(lastCall).toBeDefined();
      const delayMs = lastCall![1] as number;
      // Must be the coarse RENEW_SKEW_SECONDS floor (120_000ms), not the ~0ms
      // a naive re-computation off the still-near-expiry token would produce.
      expect(delayMs).toBeGreaterThan(60_000);
    }

    await session.stop();
  });

  it("re-arm floor: a refreshed token whose exp did NOT advance re-arms at the coarse skew backoff", async () => {
    gw = await startMockGateway();
    const nearExpirySeconds = Math.floor(Date.now() / 1000) + 5;
    const staleToken = makeJwt(nearExpirySeconds);
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: staleToken,
      // Simulates refreshSession()'s double-check short-circuit: returns a
      // token whose exp is identical to (did not advance past) the previous one.
      refresh: (_currentToken: string) => Promise.resolve(staleToken),
    });
    await session.start();

    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    try {
      await (session as unknown as { renewNow: () => Promise<void> }).renewNow();
    } finally {
      const lastCall = setTimeoutSpy.mock.calls.at(-1);
      setTimeoutSpy.mockRestore();
      expect(lastCall).toBeDefined();
      const delayMs = lastCall![1] as number;
      expect(delayMs).toBeGreaterThan(60_000);
    }

    await session.stop();
  });

  it("arms a renewal timer on connect when refresh is set, and stop() clears it", async () => {
    gw = await startMockGateway();
    const farExpirySeconds = Math.floor(Date.now() / 1000) + 3600; // 1 hour out
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: makeJwt(farExpirySeconds),
      refresh: () => Promise.resolve("t2"),
    });
    await session.start();

    const internal = session as unknown as { renewTimer?: ReturnType<typeof setTimeout> };
    expect(internal.renewTimer).toBeDefined();

    await session.stop();
    expect(internal.renewTimer).toBeUndefined();
  });

  it("does not arm a renewal timer when refresh is not supplied", async () => {
    gw = await startMockGateway();
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
    });
    await session.start();

    const internal = session as unknown as { renewTimer?: ReturnType<typeof setTimeout> };
    expect(internal.renewTimer).toBeUndefined();

    await session.stop();
  });

  it("token_renew_ack is a no-op — no status change, no throw", async () => {
    gw = await startMockGateway();
    const statuses: string[] = [];
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      onStatus: (s) => statuses.push(s),
    });
    await session.start();
    const statusesBeforeAck = [...statuses];

    gw.sendToCli({ type: "token_renew_ack" });
    await new Promise((r) => setTimeout(r, 50));

    expect(statuses).toEqual(statusesBeforeAck);

    await session.stop();
  });

  it("token_renew_error surfaces via onStatus without crashing the session", async () => {
    gw = await startMockGateway();
    const statuses: { s: string; reason?: string }[] = [];
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "test",
      onStatus: (s, reason) => statuses.push({ s, reason }),
    });
    await session.start();

    gw.sendToCli({ type: "token_renew_error", message: "x" });
    await new Promise((r) => setTimeout(r, 50));

    expect(
      statuses.some((x) => x.s === "reconnecting" && x.reason === "token renewal rejected"),
    ).toBe(true);

    // The session must still be usable — no crash, WS stays open.
    expect(gw.received.some((m: object) => (m as { type?: string }).type === "close")).toBe(false);

    await session.stop();
  });
});
