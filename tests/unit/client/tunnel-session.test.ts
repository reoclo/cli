import { describe, it, expect, afterEach } from "bun:test";
import net from "node:net";
import dgram from "node:dgram";
import { WebSocketServer } from "ws";
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
}

async function startMockGateway(opts: { echoData?: boolean } = {}): Promise<MockGateway> {
  const wss = new WebSocketServer({ port: 0 });
  const received: object[] = [];
  let activeWs: import("ws").WebSocket | null = null;
  wss.on("connection", (ws) => {
    activeWs = ws;
    ws.on("error", () => { /* swallow errors on forced close */ });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { type?: string; stream_id?: string; data?: string };
      received.push(msg);
      if (msg.type === "tunnel_open") {
        ws.send(JSON.stringify({ type: "tunnel_opened", stream_id: msg.stream_id }));
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
  return {
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
  };
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
