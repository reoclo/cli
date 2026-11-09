// src/tunnels/tls-proxy.ts
//
// The daemon's TLS listener. It accepts connections on 127.0.0.1 and ::1, picks
// the certificate by the SNI name the client asked for, and hands each secure
// socket to the manager by hostname. A name no active tunnel answers to fails
// the handshake. After the handshake the proxy never looks at the bytes, so
// WebSockets, server-sent events and keep-alive pass through unchanged.

import type net from "node:net";
import tls from "node:tls";

export interface TlsProxyOptions {
  port: number;
  /** The certificate context for a hostname. Reject to fail the handshake. */
  contextFor: (hostname: string) => Promise<tls.SecureContext>;
  onConnection: (hostname: string, socket: tls.TLSSocket) => void;
  log?: (line: string) => void;
}

export class TlsProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsProxyError";
  }
}

export class TlsProxy {
  private servers: tls.Server[] = [];
  private bound = 0;

  constructor(private readonly opts: TlsProxyOptions) {}

  get listening(): boolean {
    return this.servers.length > 0;
  }

  /** The port actually bound; differs from the option only when the option is 0. */
  get port(): number {
    return this.bound;
  }

  private make(): tls.Server {
    const server = tls.createServer({
      ALPNProtocols: ["http/1.1"],
      minVersion: "TLSv1.2",
      SNICallback: (name, cb) => {
        this.opts.contextFor(name.toLowerCase()).then(
          (ctx) => cb(null, ctx),
          (err: unknown) => {
            this.opts.log?.(`tls: refused handshake for ${JSON.stringify(name)}: ${err instanceof Error ? err.message : String(err)}`);
            cb(err instanceof Error ? err : new Error(String(err)));
          },
        );
      },
    });
    server.on("secureConnection", (sock) => this.opts.onConnection((sock.servername || "").toLowerCase(), sock));
    server.on("tlsClientError", () => undefined);
    return server;
  }

  private listen(server: tls.Server, host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port, host }, () => {
        server.off("error", reject);
        server.on("error", (err) => this.opts.log?.(`tls: listener error: ${err.message}`));
        resolve();
      });
    });
  }

  /** Bind 127.0.0.1, then ::1. Failing on 127.0.0.1 throws; a machine without IPv6 only loses the second listener. */
  async start(): Promise<void> {
    if (this.listening) return;
    const v4 = this.make();
    try {
      await this.listen(v4, "127.0.0.1", this.opts.port);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      throw new TlsProxyError(
        e.code === "EADDRINUSE"
          ? `port ${this.opts.port} is already in use, so HTTPS tunnels cannot listen; free it or set https_port in tunnels.yaml and restart the daemon`
          : `could not listen on 127.0.0.1:${this.opts.port}: ${e.message}`,
      );
    }
    this.bound = (v4.address() as net.AddressInfo).port;
    this.servers.push(v4);
    const v6 = this.make();
    try {
      await this.listen(v6, "::1", this.bound);
      this.servers.push(v6);
    } catch (err) {
      this.opts.log?.(`tls: no listener on [::1]:${this.bound}: ${(err as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    const servers = this.servers;
    this.servers = [];
    this.bound = 0;
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  }
}
