// src/tunnels/control-server.ts
//
// The daemon's control API: HTTP and JSON over a Unix socket. The run directory
// is mode 0700 and the socket 0600, so only the signed-in user can connect.

import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { ManagerError, type ManagerEvent, type TunnelManager } from "./manager";
import { TUNNEL_STATES } from "./states";

export interface ControlServerOptions {
  socketPath: string;
  manager: TunnelManager;
  version: string;
  startedAt: number;
  stateDir: string;
  log: (line: string) => void;
  /** Called after the shutdown response is written. */
  onShutdown: () => void;
  /** Milliseconds between traffic events. Default 1000. */
  trafficIntervalMs?: number;
}

export interface ControlServer {
  stop(): Promise<void>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fail(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

const STATUS_FOR: Record<ManagerError["code"], number> = { invalid: 400, not_found: 404, conflict: 409 };

async function readBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ManagerError("invalid", "the request body is not valid JSON");
  }
}

export function startControlServer(opts: ControlServerOptions): ControlServer {
  const { manager } = opts;
  const encoder = new TextEncoder();
  const closers = new Set<() => void>();

  mkdirSync(dirname(opts.socketPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(opts.socketPath), 0o700);
  rmSync(opts.socketPath, { force: true });

  const status = (): unknown => {
    const tunnels = manager.list();
    const byState: Record<string, number> = Object.fromEntries(TUNNEL_STATES.map((s) => [s, 0]));
    for (const t of tunnels) byState[t.state] = (byState[t.state] ?? 0) + 1;
    return {
      version: opts.version,
      pid: process.pid,
      uptime_seconds: Math.floor((Date.now() - opts.startedAt) / 1000),
      state_dir: opts.stateDir,
      socket: opts.socketPath,
      tunnels: { total: tunnels.length, enabled: tunnels.filter((t) => t.enabled).length, by_state: byState },
    };
  };

  const events = (): Response => {
    let cleanup = (): void => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown): void => {
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            cleanup();
          }
        };
        const onEvent = (e: ManagerEvent): void => {
          if (e.type === "log") send("log", { line: e.line });
          else send("tunnel", e);
        };
        const unsubscribe = manager.onEvent(onEvent);
        const timer = setInterval(() => {
          const snapshot = manager.trafficSnapshot();
          if (snapshot.length > 0) send("traffic", { tunnels: snapshot });
        }, opts.trafficIntervalMs ?? 1000);
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            cleanup();
          }
        }, 5000);
        let done = false;
        cleanup = () => {
          if (done) return;
          done = true;
          clearInterval(timer);
          clearInterval(heartbeat);
          unsubscribe();
          closers.delete(cleanup);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        closers.add(cleanup);
        controller.enqueue(encoder.encode(": connected\n\n"));
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  };

  const route = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    if (path === "/v1/status" && method === "GET") return json(status());
    if (path === "/v1/events" && method === "GET") return events();
    if (path === "/v1/shutdown" && method === "POST") {
      setImmediate(opts.onShutdown);
      return json({ ok: true });
    }
    if (path === "/v1/tunnels") {
      if (method === "GET") return json({ tunnels: manager.list() });
      if (method === "POST") return json(await manager.add(await readBody(req)), 201);
    }
    const m = /^\/v1\/tunnels\/([^/]+)(?:\/(up|down))?$/.exec(path);
    if (m) {
      const name = decodeURIComponent(m[1] ?? "");
      const action = m[2];
      if (action === "up" && method === "POST") return json(await manager.up(name));
      if (action === "down" && method === "POST") return json(await manager.down(name));
      if (!action && method === "GET") return json(manager.get(name));
      if (!action && method === "PATCH") return json(await manager.edit(name, await readBody(req)));
      if (!action && method === "DELETE") {
        await manager.remove(name);
        return json({ ok: true });
      }
    }
    return fail(404, "not_found", `no route for ${method} ${path}`);
  };

  const server = Bun.serve({
    unix: opts.socketPath,
    async fetch(req, srv) {
      // The event stream is long-lived: keep Bun's idle timer from closing it.
      if (new URL(req.url).pathname === "/v1/events") srv.timeout(req, 0);
      const client = req.headers.get("x-reoclo-client") ?? "unknown";
      try {
        const res = await route(req);
        if (req.method !== "GET") opts.log(`${req.method} ${new URL(req.url).pathname} from ${client} -> ${res.status}`);
        return res;
      } catch (err) {
        if (err instanceof ManagerError) {
          opts.log(`${req.method} ${new URL(req.url).pathname} from ${client} -> ${STATUS_FOR[err.code]} ${err.message}`);
          return fail(STATUS_FOR[err.code], err.code, err.message);
        }
        const message = err instanceof Error ? err.message : String(err);
        opts.log(`${req.method} ${new URL(req.url).pathname} from ${client} -> 500 ${message}`);
        return fail(500, "internal", message);
      }
    },
  });
  chmodSync(opts.socketPath, 0o600);

  return {
    async stop() {
      for (const close of [...closers]) close();
      await server.stop();
      rmSync(opts.socketPath, { force: true });
    },
  };
}
