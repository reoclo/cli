// New TunnelSession surface for the tunnel daemon: close codes on onStatus,
// extraFatalCodes, attachTcpSocket, forwardUdpDatagram, addReverse, removeReverse.

import { afterEach, describe, expect, it } from "bun:test";
import dgram from "node:dgram";
import net from "node:net";
import { TunnelSession, type SessionStatus } from "../../../src/client/tunnel-session";
import { startFakeWsGateway, type FakeWsGateway } from "../../helpers/fake-ws-gateway";

let gw: FakeWsGateway | undefined;
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
});

/** Collects status callbacks and lets a test await the exact one it needs. */
function statusLog(): {
  seen: { s: SessionStatus; reason?: string; code?: number }[];
  onStatus: (s: SessionStatus, reason?: string, code?: number) => void;
  until: (s: SessionStatus, timeoutMs?: number) => Promise<void>;
} {
  const seen: { s: SessionStatus; reason?: string; code?: number }[] = [];
  const waiters: { s: SessionStatus; resolve: () => void }[] = [];
  return {
    seen,
    onStatus(s, reason, code) {
      seen.push({ s, reason, code });
      for (const w of waiters.filter((x) => x.s === s)) w.resolve();
    },
    until(s, timeoutMs = 5000) {
      return new Promise<void>((resolve, reject) => {
        if (seen.some((x) => x.s === s)) return resolve();
        const timer = setTimeout(() => reject(new Error(`timed out waiting for status ${s}`)), timeoutMs);
        waiters.push({ s, resolve: () => { clearTimeout(timer); resolve(); } });
      });
    },
  };
}

function bound(server: net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
}

describe("TunnelSession onStatus close code", () => {
  it("passes the close code with a fatal failure", async () => {
    gw = await startFakeWsGateway();
    const log = statusLog();
    const session = new TunnelSession({ gatewayUrl: gw.url, token: "t", onStatus: log.onStatus });
    await session.start();
    gw.closeAll(4502, "runner offline");
    await log.until("failed");
    expect(log.seen.find((x) => x.s === "failed")).toEqual({ s: "failed", reason: "runner offline", code: 4502 });
    await session.stop();
  });

  it("keeps reconnecting through 4408 by default and passes the code", async () => {
    gw = await startFakeWsGateway();
    const log = statusLog();
    const session = new TunnelSession({ gatewayUrl: gw.url, token: "t", onStatus: log.onStatus });
    await session.start();
    gw.closeAll(4408, "max duration");
    await log.until("reconnecting");
    expect(log.seen.find((x) => x.s === "reconnecting")?.code).toBe(4408);
    expect(log.seen.some((x) => x.s === "failed")).toBe(false);
    await session.stop();
  });

  it("treats codes in extraFatalCodes as fatal", async () => {
    gw = await startFakeWsGateway();
    const log = statusLog();
    const session = new TunnelSession({
      gatewayUrl: gw.url,
      token: "t",
      extraFatalCodes: [4407, 4408],
      onStatus: log.onStatus,
    });
    await session.start();
    gw.closeAll(4408, "max duration");
    await log.until("failed");
    expect(log.seen.find((x) => x.s === "failed")?.code).toBe(4408);
    expect(log.seen.some((x) => x.s === "reconnecting")).toBe(false);
    await session.stop();
  });
});

describe("TunnelSession.attachTcpSocket", () => {
  it("carries a socket the caller accepted to the given target", async () => {
    gw = await startFakeWsGateway({ echo: true });
    const session = new TunnelSession({ gatewayUrl: gw.url, token: "t" });
    await session.start();
    const server = net.createServer((sock) => session.attachTcpSocket(sock, { remoteHost: "db.internal", remotePort: 5432 }));
    const port = await bound(server);
    const client = net.connect(port, "127.0.0.1");
    const echoed = new Promise<string>((resolve) => client.once("data", (b) => resolve(b.toString())));
    client.write("hello");
    expect(await echoed).toBe("hello");
    const open = await gw.waitForFrame((f) => f["type"] === "tunnel_open");
    expect(open).toMatchObject({ proto: "tcp", host: "db.internal", port: 5432 });
    client.destroy();
    await gw.waitForFrame((f) => f["type"] === "tunnel_close");
    await new Promise<void>((r) => server.close(() => r()));
    await session.stop();
  });
});

describe("TunnelSession.forwardUdpDatagram", () => {
  it("carries a datagram from a caller-owned listener and replies through it", async () => {
    gw = await startFakeWsGateway({ echo: true });
    const session = new TunnelSession({ gatewayUrl: gw.url, token: "t" });
    await session.start();
    const listener = dgram.createSocket("udp4");
    listener.on("message", (buf, rinfo) =>
      session.forwardUdpDatagram(buf, rinfo, { remoteHost: "10.0.0.5", remotePort: 53 }, listener),
    );
    await new Promise<void>((r) => listener.bind(0, "127.0.0.1", () => r()));
    const peer = dgram.createSocket("udp4");
    const reply = new Promise<string>((resolve) => peer.once("message", (b) => resolve(b.toString())));
    peer.send("ping", listener.address().port, "127.0.0.1");
    expect(await reply).toBe("ping");
    const open = await gw.waitForFrame((f) => f["type"] === "tunnel_open");
    expect(open).toMatchObject({ proto: "udp", host: "10.0.0.5", port: 53 });
    peer.close();
    listener.close();
    await session.stop();
  });
});

describe("TunnelSession reverse listeners on a running session", () => {
  it("addReverse resolves with a listen id and removeReverse closes that listener", async () => {
    gw = await startFakeWsGateway();
    const session = new TunnelSession({ gatewayUrl: gw.url, token: "t" });
    await session.start();
    const id = await session.addReverse({
      remoteBind: "127.0.0.1",
      remotePort: 8080,
      localHost: "127.0.0.1",
      localPort: 3000,
      proto: "tcp",
    });
    const open = await gw.waitForFrame((f) => f["type"] === "tunnel_listen_open");
    expect(open).toMatchObject({ listen_id: id, port: 8080, bind: "127.0.0.1", proto: "tcp" });
    session.removeReverse(id);
    const close = await gw.waitForFrame((f) => f["type"] === "tunnel_listen_close");
    expect(close["listen_id"]).toBe(id);
    // A second remove is a no-op, and stop() has nothing left to close.
    session.removeReverse(id);
    await session.stop();
    expect(gw.frames.filter((f) => f["type"] === "tunnel_listen_close")).toHaveLength(1);
  });
});
