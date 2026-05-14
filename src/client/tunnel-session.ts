import net from "node:net";
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export type Proto = "tcp" | "udp";

export interface ForwardSpec {
  localBind: string; // "127.0.0.1" default
  localPort: number; // 0 for ephemeral
  remoteHost: string;
  remotePort: number;
  proto: Proto;
}

export type SessionStatus = "connecting" | "active" | "reconnecting" | "closed";

export interface ReverseSpec {
  remoteBind: "127.0.0.1" | "0.0.0.0"; // server-side bind address
  remotePort: number;                    // server-side listen port
  localHost: string;                     // local dial target host
  localPort: number;                     // local dial target port
  proto: Proto;
}

export interface TunnelSessionOptions {
  gatewayUrl: string; // wss://direct.reoclo.com/v1/tunnel?server_id=...
  token: string; // user JWT for Authorization: Bearer
  forwards?: ForwardSpec[];
  reverses?: ReverseSpec[];
  reconnectDeadlineMs?: number; // default 5 * 60_000
  onStatus?: (s: SessionStatus) => void;
}

export interface ReadyState {
  forwards: { boundPort: number }[];
  reverses: { boundPort: number }[];
}

interface TcpStream {
  proto: "tcp";
  sock: net.Socket;
}

interface UdpStream {
  proto: "udp";
  localPeer: { addr: string; port: number };
  localSock: dgram.Socket; // the same listener that received the source datagram
  idleTimer: NodeJS.Timeout;
}

interface UdpReverseStream {
  proto: "udp-reverse";
  sock: dgram.Socket;
  target: { addr: string; port: number };
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const UDP_IDLE_MS = 60_000;

export class TunnelSession {
  private ws?: WebSocket;
  /** WS that is currently in the connecting state (not yet open) */
  private connectingWs?: WebSocket;
  private streams = new Map<string, TcpStream | UdpStream | UdpReverseStream>();
  /** UDP forward: source-peer key "addr:port" → stream_id */
  private udpPeerToStream = new Map<string, string>();
  private tcpListeners: net.Server[] = [];
  private udpListeners: dgram.Socket[] = [];
  private stopped = false;
  private interrupted = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** Timestamp of the first consecutive disconnect; null when connected. */
  private reconnectStartedAt: number | null = null;
  private opts: TunnelSessionOptions & { reconnectDeadlineMs: number };

  /** Active reverse listeners: listen_id → ReverseSpec (for inbound tunnel_open routing) */
  private reverseListeners = new Map<string, ReverseSpec>();
  /** Pending waiters for tunnel_listen_opened / tunnel_listen_error, keyed by listen_id */
  private listenWaiters = new Map<string, (msg: Record<string, unknown>) => void>();

  constructor(opts: TunnelSessionOptions) {
    this.opts = { reconnectDeadlineMs: 5 * 60_000, ...opts };
  }

  async start(): Promise<ReadyState> {
    await this.connect();
    const forwards = await this.openLocalListeners();
    const reverses = await this.openReverseListeners();
    return { forwards, reverses };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Send tunnel_listen_close for each active reverse listener so runner cleans up server-side ports
    for (const listenId of this.reverseListeners.keys()) {
      this.send({ type: "tunnel_listen_close", listen_id: listenId });
    }
    this.reverseListeners.clear();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    for (const s of this.tcpListeners) s.close();
    for (const s of this.udpListeners) s.close();
    for (const [id, s] of this.streams.entries()) {
      if (s.proto === "udp") {
        clearTimeout(s.idleTimer);
      }
      this.tearDownStream(id, "session_stopped");
    }
    // Abort any in-progress connect by destroying the underlying socket
    if (this.connectingWs) {
      (this.connectingWs as unknown as { _socket?: { destroy(): void } })._socket?.destroy();
      this.connectingWs = undefined;
    }
    // Wait for the active WS to close gracefully (with a short timeout)
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          (this.ws as unknown as { _socket?: { destroy(): void } })._socket?.destroy();
          resolve();
        }, 500);
        this.ws!.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        this.ws!.close();
      });
    }
    this.opts.onStatus?.("closed");
  }

  private status(s: SessionStatus): void {
    this.opts.onStatus?.(s);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.status(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.opts.gatewayUrl, {
        headers: { Authorization: `Bearer ${this.opts.token}` },
      });
      this.connectingWs = ws;
      const onOpen = () => {
        cleanup();
        this.connectingWs = undefined;
        if (this.stopped) {
          ws.terminate();
          resolve();
          return;
        }
        this.ws = ws;
        this.reconnectAttempt = 0;
        this.reconnectStartedAt = null; // success — clear the disconnect timer
        this.status("active");
        ws.on("message", (raw) => this.onWsMessage(raw));
        ws.on("close", () => this.onWsClose());
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        this.connectingWs = undefined;
        reject(err);
      };
      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
      };
      // Attach a permanent error handler immediately so no error goes unhandled
      ws.on("error", () => {
        /* close will fire after error */
      });
      ws.once("open", onOpen);
      ws.once("error", onError);
    });
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private addListenWaiter(listenId: string, fn: (msg: Record<string, unknown>) => void): void {
    this.listenWaiters.set(listenId, fn);
  }

  private removeListenWaiter(listenId: string): void {
    this.listenWaiters.delete(listenId);
  }

  private async openReverseListeners(): Promise<{ boundPort: number }[]> {
    const out: { boundPort: number }[] = [];
    for (const r of this.opts.reverses ?? []) {
      const listenId = `l-${randomUUID()}`;
      this.reverseListeners.set(listenId, r);
      try {
        const boundPort = await this.sendListenOpen(listenId, r);
        out.push({ boundPort });
      } catch (err) {
        // Remove the stale entry so stop() doesn't try to close a never-opened listener
        this.reverseListeners.delete(listenId);
        throw err;
      }
    }
    return out;
  }

  private sendListenOpen(listenId: string, r: ReverseSpec): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListenWaiter(listenId);
        reject(new Error(`tunnel_listen_open timeout for listen_id=${listenId}`));
      }, 10_000);
      const onMsg = (msg: Record<string, unknown>) => {
        clearTimeout(timeout);
        if (msg.type === "tunnel_listen_opened") {
          this.removeListenWaiter(listenId);
          resolve(typeof msg.port === "number" ? msg.port : 0);
        } else if (msg.type === "tunnel_listen_error") {
          this.removeListenWaiter(listenId);
          reject(new Error(typeof msg.error === "string" ? msg.error : "listen error"));
        }
      };
      this.addListenWaiter(listenId, onMsg);
      this.send({
        type: "tunnel_listen_open",
        listen_id: listenId,
        proto: r.proto,
        port: r.remotePort,
        bind: r.remoteBind,
      });
    });
  }

  private tearDownStream(streamId: string, reason: string): void {
    const s = this.streams.get(streamId);
    if (!s) return;
    this.streams.delete(streamId);
    if (s.proto === "tcp") {
      // end() lets the local app see EOF cleanly
      s.sock.end();
    } else if (s.proto === "udp") {
      clearTimeout(s.idleTimer);
      // For UDP we don't close the listener socket; we just forget the peer mapping
      const key = `${s.localPeer.addr}:${s.localPeer.port}`;
      this.udpPeerToStream.delete(key);
    } else {
      // udp-reverse: close the ephemeral socket
      s.sock.close();
    }
    this.send({ type: "tunnel_close", stream_id: streamId, reason });
  }

  private onWsClose(): void {
    // A full WS reconnect is a clean slate — any prior runner-interrupt state
    // (signalled over the now-dead WS) no longer applies. Clear it so the
    // accept-guard doesn't stay stuck after the WS comes back.
    this.interrupted = false;
    // Drain pending listen waiters so sendListenOpen promises settle instead of hanging
    for (const [listenId, w] of this.listenWaiters) {
      try {
        w({ type: "tunnel_listen_error", listen_id: listenId, error: "ws_closed_before_ack" });
      } catch { /* ignore */ }
    }
    this.listenWaiters.clear();

    // Clean local TCP/UDP-reverse streams so the local app sees a clean drop, not a hang
    for (const [id, s] of this.streams.entries()) {
      if (s.proto === "tcp") {
        s.sock.end();
      } else if (s.proto === "udp") {
        clearTimeout(s.idleTimer);
      } else {
        // udp-reverse
        s.sock.close();
      }
      this.streams.delete(id);
    }
    this.udpPeerToStream.clear();
    // reverseListeners intentionally preserved — re-armed on reconnect

    if (this.stopped) return;
    // Record the start of the first consecutive disconnect only
    if (this.reconnectStartedAt === null) this.reconnectStartedAt = Date.now();
    this.status("reconnecting");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const startedAt = this.reconnectStartedAt ?? Date.now();
    const deadline = startedAt + this.opts.reconnectDeadlineMs;
    const tryAgain = async (): Promise<void> => {
      if (this.stopped) return;
      if (Date.now() > deadline) {
        // Give up — emit closed and propagate via stop() so the CLI can exit non-zero.
        this.status("closed");
        // Don't call stop() (it sends frames on closed WS); just clean local listeners
        for (const s of this.tcpListeners) s.close();
        for (const s of this.udpListeners) s.close();
        return;
      }
      this.reconnectAttempt++;
      const backoff = Math.min(
        BACKOFF_MAX_MS,
        BACKOFF_BASE_MS * 2 ** Math.min(this.reconnectAttempt, 6),
      );
      this.reconnectTimer = setTimeout(async () => {
        this.reconnectTimer = undefined;
        try {
          await this.connect();
          // Re-arm reverse listeners so the runner re-binds its server-side ports
          this.rearmReverseListeners();
        } catch {
          void tryAgain();
        }
      }, backoff);
    };
    void tryAgain();
  }

  /**
   * Re-sends tunnel_listen_open for every active reverse listener.
   * Called on WS-level reconnect AND on tunnel_resumed (runner re-registration).
   * Don't await — the runner re-binds asynchronously; errors arrive as tunnel_listen_error later.
   */
  private rearmReverseListeners(): void {
    for (const [listenId, spec] of this.reverseListeners.entries()) {
      this.send({
        type: "tunnel_listen_open",
        listen_id: listenId,
        proto: spec.proto,
        port: spec.remotePort,
        bind: spec.remoteBind,
      });
    }
  }

  private async openLocalListeners(): Promise<{ boundPort: number }[]> {
    const out: { boundPort: number }[] = [];
    for (const f of this.opts.forwards ?? []) {
      if (f.proto === "tcp") {
        const server = net.createServer((sock) => this.onLocalTcpAccept(sock, f));
        await new Promise<void>((r, j) => {
          server.once("error", j);
          server.listen(f.localPort, f.localBind, () => r());
        });
        out.push({ boundPort: (server.address() as net.AddressInfo).port });
        this.tcpListeners.push(server);
      } else {
        const sock = dgram.createSocket("udp4");
        await new Promise<void>((r, j) => {
          sock.once("error", j);
          sock.bind(f.localPort, f.localBind, () => r());
        });
        sock.on("message", (buf, rinfo) => this.onLocalUdpDatagram(buf, rinfo, f, sock));
        out.push({ boundPort: (sock.address() as net.AddressInfo).port });
        this.udpListeners.push(sock);
      }
    }
    return out;
  }

  private onLocalTcpAccept(sock: net.Socket, f: ForwardSpec): void {
    // Drop new connections fast while interrupted — gateway would drop the tunnel_open anyway.
    if (this.interrupted) { sock.destroy(); return; }
    const streamId = `s-${randomUUID()}`;
    this.streams.set(streamId, { proto: "tcp", sock });
    this.send({
      type: "tunnel_open",
      stream_id: streamId,
      proto: "tcp",
      host: f.remoteHost,
      port: f.remotePort,
    });
    sock.on("data", (buf: Buffer) => {
      this.send({ type: "tunnel_data", stream_id: streamId, data: buf.toString("base64") });
    });
    sock.on("close", () => {
      if (this.streams.delete(streamId)) {
        this.send({ type: "tunnel_close", stream_id: streamId });
      }
    });
    sock.on("error", () => sock.destroy());
  }

  private onLocalUdpDatagram(
    buf: Buffer,
    rinfo: dgram.RemoteInfo,
    f: ForwardSpec,
    listener: dgram.Socket,
  ): void {
    // Drop new datagrams while interrupted — gateway would drop tunnel_open anyway.
    if (this.interrupted) return;
    const key = `${rinfo.address}:${rinfo.port}`;
    let streamId = this.udpPeerToStream.get(key);
    if (!streamId) {
      streamId = `s-${randomUUID()}`;
      this.udpPeerToStream.set(key, streamId);
      this.streams.set(streamId, {
        proto: "udp",
        localPeer: { addr: rinfo.address, port: rinfo.port },
        localSock: listener,
        idleTimer: setTimeout(
          () => this.tearDownStream(streamId!, "udp_idle_timeout"),
          UDP_IDLE_MS,
        ),
      });
      this.send({
        type: "tunnel_open",
        stream_id: streamId,
        proto: "udp",
        host: f.remoteHost,
        port: f.remotePort,
      });
    }
    this.send({ type: "tunnel_data", stream_id: streamId, data: buf.toString("base64") });
    this.resetUdpIdle(streamId);
  }

  private resetUdpIdle(streamId: string): void {
    const s = this.streams.get(streamId);
    if (!s || s.proto !== "udp") return;
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      this.tearDownStream(streamId, "udp_idle_timeout");
    }, UDP_IDLE_MS);
  }

  private onWsMessage(raw: WebSocket.RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    // Dispatch tunnel_listen_opened / tunnel_listen_error to pending sendListenOpen() callers
    if (msg.type === "tunnel_listen_opened" || msg.type === "tunnel_listen_error") {
      if (typeof msg.listen_id === "string") {
        const w = this.listenWaiters.get(msg.listen_id);
        if (w) w(msg);
      }
      // Defensive sweep (Issue 1): if this is a reconnect-era error with no pending waiter,
      // remove the stale reverseListeners entry so the failure is surfaced, not silently dropped.
      if (msg.type === "tunnel_listen_error" && typeof msg.listen_id === "string") {
        if (this.reverseListeners.delete(msg.listen_id)) {
          process.stderr.write(
            `tunnel: reverse listener ${msg.listen_id} failed after reconnect: ${typeof msg.error === "string" ? msg.error : "unknown"}\n`,
          );
        }
      }
      return;
    }

    // Handle gateway-signalled interrupt/resume (no stream_id — must come before the sid guard)
    if (msg.type === "tunnel_interrupted") {
      // Gateway is holding our WS open while the runner reconnects.
      // In-flight streams were already torn down via tunnel_close frames.
      this.interrupted = true;
      this.opts.onStatus?.("reconnecting");
      return;
    }
    if (msg.type === "tunnel_resumed") {
      // Runner re-registered. Re-arm reverse listeners — the runner lost its
      // server-side bind state and must re-create the listeners.
      this.interrupted = false;
      this.rearmReverseListeners();
      this.opts.onStatus?.("active");
      return;
    }

    const sid = msg.stream_id;
    if (typeof sid !== "string") return;

    switch (msg.type) {
      case "tunnel_opened":
        // No-op for forward path — local socket is already accepting bytes
        return;

      case "tunnel_open": {
        // Reverse-path: gateway is forwarding an inbound connection from the runner.
        const lid = msg.listen_id;
        if (typeof lid !== "string") return;
        const spec = this.reverseListeners.get(lid);
        if (!spec) {
          // Listener not registered (race or bug). Tell gateway to close it.
          this.send({ type: "tunnel_close", stream_id: sid, reason: "no_local_listener" });
          return;
        }
        if (spec.proto === "tcp") {
          const sock = net.createConnection({ host: spec.localHost, port: spec.localPort });
          this.streams.set(sid, { proto: "tcp", sock });
          sock.on("data", (buf) => {
            this.send({ type: "tunnel_data", stream_id: sid, data: buf.toString("base64") });
          });
          sock.on("close", () => {
            if (this.streams.delete(sid)) {
              this.send({ type: "tunnel_close", stream_id: sid });
            }
          });
          sock.on("error", (err) => {
            if (this.streams.delete(sid)) {
              this.send({
                type: "tunnel_close",
                stream_id: sid,
                reason: `local_dial_error: ${err.message}`,
              });
            }
          });
        } else {
          // UDP reverse: bind a local ephemeral socket to receive replies from the local target.
          const sock = dgram.createSocket("udp4");
          // Register error handler BEFORE bind so a synchronous error event is always handled.
          sock.on("error", (err) => {
            if (this.streams.delete(sid)) {
              this.send({ type: "tunnel_close", stream_id: sid, reason: `local_udp_error: ${err.message}` });
            }
          });
          sock.on("message", (buf) => {
            this.send({ type: "tunnel_data", stream_id: sid, data: buf.toString("base64") });
          });
          sock.bind(0);
          this.streams.set(sid, {
            proto: "udp-reverse",
            sock,
            target: { addr: spec.localHost, port: spec.localPort },
          });
        }
        return;
      }

      case "tunnel_data": {
        const s = this.streams.get(sid);
        if (!s) return;
        const data =
          typeof msg.data === "string" ? Buffer.from(msg.data as string, "base64") : Buffer.alloc(0);
        if (s.proto === "tcp") {
          // Note: bounded flow control comes in Phase 6 (bandwidth policy).
          // For now we log when the local app's read buffer is full so it's visible.
          const drained = s.sock.write(data);
          if (!drained) {
            console.warn(`[tunnel] local TCP write backpressure on stream ${sid}`);
          }
        } else if (s.proto === "udp") {
          s.localSock.send(data, s.localPeer.port, s.localPeer.addr);
          this.resetUdpIdle(sid);
        } else {
          // udp-reverse: forward data to the local target
          s.sock.send(data, s.target.port, s.target.addr);
        }
        return;
      }

      case "tunnel_error":
      case "tunnel_close": {
        const s = this.streams.get(sid);
        if (!s) return;
        this.streams.delete(sid);
        if (s.proto === "tcp") {
          s.sock.end();
        } else if (s.proto === "udp") {
          clearTimeout(s.idleTimer);
          this.udpPeerToStream.delete(`${s.localPeer.addr}:${s.localPeer.port}`);
        } else {
          s.sock.close();
        }
        return;
      }

      default:
        return;
    }
  }
}
