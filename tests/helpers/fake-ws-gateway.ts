// tests/helpers/fake-ws-gateway.ts
//
// A local stand-in for the gateway's tunnel WebSocket. It records every frame
// and connection, answers tunnel_open and tunnel_listen_open the way the real
// gateway does, can echo stream data, and can close every connection with a
// chosen code. Tests wait on exact events with a bounded timeout, never on a
// fixed delay.

import { EventEmitter } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";

export type Frame = Record<string, unknown>;

export interface FakeWsGateway {
  /** ws://127.0.0.1:<port>, to use as the direct URL or the gateway URL. */
  url: string;
  frames: Frame[];
  /** Request path and query of every connection, in order. */
  urls: string[];
  /** Connections accepted so far. */
  connections: number;
  /** Connections that have closed so far. */
  closed: number;
  /** Send a close frame with `code` on every open connection. */
  closeAll(code?: number, reason?: string): void;
  /** Resolve once `predicate` holds; re-checked on every frame, connect and close. */
  waitFor(predicate: () => boolean, what: string, timeoutMs?: number): Promise<void>;
  waitForFrame(predicate: (f: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
  stop(): Promise<void>;
}

export async function startFakeWsGateway(opts: { echo?: boolean } = {}): Promise<FakeWsGateway> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const changed = new EventEmitter();
  changed.setMaxListeners(0);
  const sockets = new Set<WebSocket>();
  const gw: FakeWsGateway = {
    url: "",
    frames: [],
    urls: [],
    connections: 0,
    closed: 0,
    closeAll(code, reason) {
      for (const ws of sockets) {
        if (code === undefined) ws.close();
        else ws.close(code, reason);
      }
    },
    waitFor(predicate, what, timeoutMs = 5000) {
      return new Promise<void>((resolve, reject) => {
        if (predicate()) return resolve();
        const timer = setTimeout(() => {
          changed.off("change", check);
          reject(new Error(`timed out after ${timeoutMs}ms waiting for ${what}`));
        }, timeoutMs);
        const check = (): void => {
          if (!predicate()) return;
          clearTimeout(timer);
          changed.off("change", check);
          resolve();
        };
        changed.on("change", check);
      });
    },
    async waitForFrame(predicate, timeoutMs) {
      await gw.waitFor(() => gw.frames.some(predicate), "a matching frame", timeoutMs);
      return gw.frames.find(predicate) as Frame;
    },
    stop() {
      return new Promise<void>((resolve) => {
        for (const ws of sockets) (ws as unknown as { _socket?: { destroy(): void } })._socket?.destroy();
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          resolve();
        };
        // wss.close()'s callback is unreliable under Bun; race it with a short timer.
        const timer = setTimeout(finish, 300);
        wss.close(() => {
          clearTimeout(timer);
          finish();
        });
      });
    },
  };

  wss.on("connection", (ws, req) => {
    sockets.add(ws);
    gw.connections++;
    gw.urls.push(req.url ?? "");
    ws.on("error", () => undefined);
    ws.on("message", (raw) => {
      const text = Array.isArray(raw) ? Buffer.concat(raw).toString() : Buffer.from(raw as Buffer).toString();
      const msg = JSON.parse(text) as Frame;
      gw.frames.push(msg);
      if (msg["type"] === "tunnel_open") {
        ws.send(JSON.stringify({ type: "tunnel_opened", stream_id: msg["stream_id"] }));
      } else if (msg["type"] === "tunnel_listen_open") {
        ws.send(JSON.stringify({ type: "tunnel_listen_opened", listen_id: msg["listen_id"], port: msg["port"] }));
      } else if (msg["type"] === "tunnel_data" && opts.echo) {
        ws.send(JSON.stringify({ type: "tunnel_data", stream_id: msg["stream_id"], data: msg["data"] }));
      }
      changed.emit("change");
    });
    ws.on("close", () => {
      sockets.delete(ws);
      gw.closed++;
      changed.emit("change");
    });
    changed.emit("change");
  });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  gw.url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  return gw;
}

/** A TCP port that is free on 127.0.0.1 right now. */
export async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}
