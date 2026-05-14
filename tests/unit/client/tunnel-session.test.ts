import { describe, it, expect, afterEach } from "bun:test";
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
  /** Frames received from the CLI, in order */
  received: object[];
  /** Send a frame to whatever CLI is currently connected */
  sendToCli: (msg: object) => void;
  /** Called for every frame received from the CLI (optional override) */
  onClientFrame?: (msg: Record<string, unknown>) => void;
}

interface MockGatewayOpts {
  echoData?: boolean;
  /** Called when a tunnel_listen_open frame arrives from the CLI */
  onListenOpen?: (msg: Record<string, unknown>, ws: WebSocket) => void;
}

async function startMockGateway(opts: MockGatewayOpts = {}): Promise<MockGateway> {
  const wss = new WebSocketServer({ port: 0 });
  const received: object[] = [];
  let activeWs: WebSocket | null = null;
  let onClientFrame: ((msg: Record<string, unknown>) => void) | undefined;

  wss.on("connection", (ws) => {
    activeWs = ws;
    ws.on("error", () => { /* swallow errors on forced close */ });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
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
    sendToCli: (msg) => activeWs?.send(JSON.stringify(msg)),
    dropConnections: () => {
      for (const client of wss.clients) {
        (client as unknown as { _socket?: { destroy(): void } })._socket?.destroy();
      }
    },
    stop: () =>
      new Promise((r) => {
        for (const client of wss.clients) {
          (client as unknown as { _socket?: { destroy(): void } })._socket?.destroy();
        }
        wss.close(() => r());
      }),
    get onClientFrame() { return onClientFrame; },
    set onClientFrame(fn) { onClientFrame = fn; },
  };
  return gw;
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
