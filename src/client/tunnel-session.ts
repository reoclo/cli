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

export interface TunnelSessionOptions {
  gatewayUrl: string; // wss://direct.reoclo.com/v1/tunnel?server_id=...
  token: string; // user JWT for Authorization: Bearer
  forwards?: ForwardSpec[];
  reconnectDeadlineMs?: number; // default 5 * 60_000
  onStatus?: (s: SessionStatus) => void;
}

export interface ReadyState {
  forwards: { boundPort: number }[];
}

interface TcpStream {
  proto: "tcp";
  sock: net.Socket;
}

interface UdpStream {
  proto: "udp";
  localPeer: { addr: string; port: number };
  localSock: dgram.Socket; // the same listener that received the source datagram
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;

export class TunnelSession {
  private ws?: WebSocket;
  /** WS that is currently in the connecting state (not yet open) */
  private connectingWs?: WebSocket;
  private streams = new Map<string, TcpStream | UdpStream>();
  /** UDP forward: source-peer key "addr:port" → stream_id */
  private udpPeerToStream = new Map<string, string>();
  private tcpListeners: net.Server[] = [];
  private udpListeners: dgram.Socket[] = [];
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private opts: TunnelSessionOptions & { reconnectDeadlineMs: number };

  constructor(opts: TunnelSessionOptions) {
    this.opts = { reconnectDeadlineMs: 5 * 60_000, ...opts };
  }

  async start(): Promise<ReadyState> {
    await this.connect();
    const forwards = await this.openLocalListeners();
    return { forwards };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    for (const s of this.tcpListeners) s.close();
    for (const s of this.udpListeners) s.close();
    for (const id of Array.from(this.streams.keys())) {
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

  private tearDownStream(streamId: string, reason: string): void {
    const s = this.streams.get(streamId);
    if (!s) return;
    this.streams.delete(streamId);
    if (s.proto === "tcp") {
      // end() lets the local app see EOF cleanly
      s.sock.end();
    } else {
      // For UDP we don't close the listener socket; we just forget the peer mapping
      const key = `${s.localPeer.addr}:${s.localPeer.port}`;
      this.udpPeerToStream.delete(key);
    }
    this.send({ type: "tunnel_close", stream_id: streamId, reason });
  }

  private onWsClose(): void {
    // Clean local TCP streams so the local app sees a clean drop, not a hang
    for (const [id, s] of this.streams.entries()) {
      if (s.proto === "tcp") {
        s.sock.end();
      }
      this.streams.delete(id);
    }
    this.udpPeerToStream.clear();

    if (this.stopped) return;
    this.status("reconnecting");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const deadline = Date.now() + this.opts.reconnectDeadlineMs;
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
        } catch {
          void tryAgain();
        }
      }, backoff);
    };
    void tryAgain();
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
    const key = `${rinfo.address}:${rinfo.port}`;
    let streamId = this.udpPeerToStream.get(key);
    if (!streamId) {
      streamId = `s-${randomUUID()}`;
      this.udpPeerToStream.set(key, streamId);
      this.streams.set(streamId, {
        proto: "udp",
        localPeer: { addr: rinfo.address, port: rinfo.port },
        localSock: listener,
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
  }

  private onWsMessage(raw: WebSocket.RawData): void {
    let msg: {
      type?: string;
      stream_id?: string;
      data?: string;
      reason?: string;
      error?: string;
    };
    try {
      msg = JSON.parse(raw.toString()) as typeof msg;
    } catch {
      return;
    }
    const sid = msg.stream_id;
    if (typeof sid !== "string") return;
    switch (msg.type) {
      case "tunnel_opened":
        // No-op for forward path — local socket is already accepting bytes
        return;
      case "tunnel_data": {
        const s = this.streams.get(sid);
        if (!s) return;
        const data =
          typeof msg.data === "string" ? Buffer.from(msg.data, "base64") : Buffer.alloc(0);
        if (s.proto === "tcp") {
          s.sock.write(data);
        } else {
          s.localSock.send(data, s.localPeer.port, s.localPeer.addr);
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
        } else {
          this.udpPeerToStream.delete(`${s.localPeer.addr}:${s.localPeer.port}`);
        }
        return;
      }
      default:
        return;
    }
  }
}
