// src/tunnels/hosts-client.ts
//
// How the tunnel daemon and the CLI talk to the root hosts helper: one JSON
// object per line over a Unix socket.

import net from "node:net";
import { hostsdSocketPath } from "../hostsd/paths";
import type { HelperStatus } from "../hostsd/main";

export type { HelperStatus };

export class HostsError extends Error {
  constructor(
    readonly code: "not_installed" | "refused" | "io",
    message: string,
  ) {
    super(message);
    this.name = "HostsError";
  }
}

/** What the manager needs from the helper, so tests can swap in a fake. */
export interface HostsSink {
  status(): Promise<HelperStatus>;
  set(entries: readonly string[]): Promise<HelperStatus>;
}

export class HostsClient implements HostsSink {
  constructor(
    private readonly socket: string = hostsdSocketPath(),
    private readonly timeoutMs = 5000,
  ) {}

  private request(body: Record<string, unknown>): Promise<HelperStatus> {
    return new Promise((resolve, reject) => {
      const conn = net.connect(this.socket);
      let buffered = "";
      const finish = (fn: () => void): void => {
        conn.destroy();
        fn();
      };
      conn.setEncoding("utf8");
      conn.setTimeout(this.timeoutMs, () => finish(() => reject(new HostsError("io", "the hosts helper did not answer in time"))));
      conn.once("connect", () => conn.write(JSON.stringify(body) + "\n"));
      conn.on("data", (chunk: string) => {
        buffered += chunk;
        const nl = buffered.indexOf("\n");
        if (nl < 0) return;
        let reply: { ok?: boolean; error?: string } & Partial<HelperStatus>;
        try {
          reply = JSON.parse(buffered.slice(0, nl)) as typeof reply;
        } catch {
          finish(() => reject(new HostsError("io", "the hosts helper sent an unreadable reply")));
          return;
        }
        if (reply.ok) finish(() => resolve(reply as HelperStatus));
        else finish(() => reject(new HostsError("refused", reply.error ?? "the hosts helper refused the request")));
      });
      conn.once("error", (err: NodeJS.ErrnoException) => {
        const missing = err.code === "ENOENT" || err.code === "ECONNREFUSED";
        reject(
          missing
            ? new HostsError("not_installed", "the hosts helper is not installed; run: reoclo hosts setup")
            : new HostsError("io", `could not reach the hosts helper: ${err.message}`),
        );
      });
    });
  }

  status(): Promise<HelperStatus> {
    return this.request({ op: "status" });
  }

  set(entries: readonly string[]): Promise<HelperStatus> {
    return this.request({ op: "set", entries });
  }
}
