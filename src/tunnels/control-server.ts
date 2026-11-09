// src/tunnels/control-server.ts
//
// The daemon's control API: HTTP and JSON over a Unix socket. The run directory
// is mode 0700 and the socket 0600, so only the signed-in user can connect.

import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { ApprovalStore, type ApprovalStoreOptions, type ApprovalView } from "./approvals";
import type { AuthFlow } from "./auth-flow";
import { mergeSuffixList, type CaActions } from "./ca-actions";
import type { Directory } from "./directory";
import { callerOf, gateAdd, gateCa, gateEdit, gateRemove, gateShare, gateUnshare, gateUp, type Gate } from "./gating";
import { ForegroundNotFound, listForeground, stopForeground, type ForegroundTunnel } from "./foreground";
import { HostnameError } from "./hosts-block";
import { DEFAULT_ADHOC_TTL_MINUTES, ManagerError, type ManagerEvent, type TunnelManager } from "./manager";
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
  /** Tunnels running in terminals. Tests replace this; the daemon reads the registry. */
  foreground?: { list(): ForegroundTunnel[]; stop(id: string): Promise<void> };
  /** Organizations, servers, ports and server lookup. Without it those routes answer 502. */
  directory?: Directory;
  /** The device-flow sign-in behind POST /v1/auth/login. */
  auth?: AuthFlow;
  /** Trusting and untrusting the local CA behind POST /v1/ca/trust and /untrust. */
  caActions?: CaActions;
  approvals?: Pick<ApprovalStoreOptions, "now" | "timers" | "ttlMs" | "newId">;
}

export interface ControlServer {
  approvals: ApprovalStore;
  stop(): Promise<void>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fail(status: number, code: string, message: string, state?: string): Response {
  return json({ error: { code, message, ...(state ? { state } : {}) } }, status);
}

const STATUS_FOR: Record<ManagerError["code"], number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  upstream: 502,
};

async function readBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ManagerError("invalid", "the request body is not valid JSON");
  }
}

function objectOf(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

interface OpenRequest {
  server: string;
  org: string;
  profile?: string;
  target: string;
  kind: "tcp" | "udp";
  ttl_minutes: number;
}

function parseOpenRequest(raw: unknown): OpenRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManagerError("invalid", "the request must be an object");
  }
  const b = raw as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const v = b[key];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  };
  const server = text("server");
  const org = text("org");
  const target = text("target");
  if (server === undefined) throw new ManagerError("invalid", "server is required (a name, slug or id)");
  if (org === undefined) throw new ManagerError("invalid", "org is required");
  if (target === undefined) throw new ManagerError("invalid", "target is required (HOST:PORT or a port)");
  const kind = b["kind"] ?? "tcp";
  if (kind !== "tcp" && kind !== "udp") throw new ManagerError("invalid", "kind must be tcp or udp");
  const ttl = b["ttl_minutes"] ?? DEFAULT_ADHOC_TTL_MINUTES;
  if (typeof ttl !== "number") throw new ManagerError("invalid", "ttl_minutes must be a number");
  const profile = text("profile");
  return {
    server,
    org,
    ...(profile === undefined ? {} : { profile }),
    target: /^\d+$/.test(target) ? `127.0.0.1:${target}` : target,
    kind,
    ttl_minutes: ttl,
  };
}

export function startControlServer(opts: ControlServerOptions): ControlServer {
  const { manager } = opts;
  const encoder = new TextEncoder();
  const closers = new Set<() => void>();
  const subscribers = new Set<(event: string, data: unknown) => void>();
  const foreground = opts.foreground ?? { list: () => listForeground(), stop: (id: string) => stopForeground(id) };
  let loginInFlight = false;

  const publish = (event: string, data: unknown): void => {
    for (const fn of [...subscribers]) fn(event, data);
  };

  const approvals = new ApprovalStore({
    ...opts.approvals,
    onChange: (approval: ApprovalView) => publish("approval", { approvals: approvals.list(), approval }),
  });

  mkdirSync(dirname(opts.socketPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(opts.socketPath), 0o700);
  rmSync(opts.socketPath, { force: true });

  const unavailable = (what: string): never => {
    throw new ManagerError("upstream", `${what} is not available in this daemon`);
  };

  const status = async (): Promise<unknown> => {
    const tunnels = manager.list();
    const [ca, hosts, signedIn, tailscale] = await Promise.all([
      manager.caStatus(),
      manager.hostsStatus(),
      opts.directory?.signedIn(),
      manager.tailscaleStatus(),
    ]);
    const byState: Record<string, number> = Object.fromEntries(TUNNEL_STATES.map((s) => [s, 0]));
    for (const t of tunnels) byState[t.state] = (byState[t.state] ?? 0) + 1;
    return {
      version: opts.version,
      pid: process.pid,
      uptime_seconds: Math.floor((Date.now() - opts.startedAt) / 1000),
      state_dir: opts.stateDir,
      socket: opts.socketPath,
      ...(signedIn === undefined ? {} : { signed_in: signedIn }),
      tunnels: { total: tunnels.length, enabled: tunnels.filter((t) => t.enabled).length, by_state: byState },
      https: manager.httpsStatus(),
      ca,
      hosts,
      tailscale,
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
        subscribers.add(send);
        let lastForeground = "[]";
        const pushForeground = (): void => {
          let next: string;
          let tunnels: ForegroundTunnel[] = [];
          try {
            tunnels = foreground.list();
            next = JSON.stringify(tunnels);
          } catch (err) {
            next = `error: ${err instanceof Error ? err.message : String(err)}`;
            if (next !== lastForeground) send("log", { line: `could not read terminal tunnels: ${next}` });
            lastForeground = next;
            return;
          }
          if (next === lastForeground) return;
          lastForeground = next;
          send("foreground", { tunnels });
        };
        pushForeground();
        const timer = setInterval(() => {
          const snapshot = manager.trafficSnapshot();
          if (snapshot.length > 0) send("traffic", { tunnels: snapshot });
          pushForeground();
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
          subscribers.delete(send);
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

  const startLogin = (profile: string | undefined): Response => {
    const flow = opts.auth ?? unavailable("sign-in");
    if (loginInFlight) throw new ManagerError("conflict", "a sign-in is already waiting for approval");
    loginInFlight = true;
    flow
      .login({ profile }, (pending) => publish("auth", pending))
      .then(
        (done) => publish("auth", done),
        (err: unknown) => publish("auth", { status: "failed", message: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => {
        loginInFlight = false;
      });
    return json({ ok: true }, 202);
  };

  const caAction = async (verb: "trust" | "untrust", domains: unknown): Promise<unknown> => {
    const actions = opts.caActions ?? unavailable("trusting the CA");
    if (verb === "untrust") {
      const { lines } = await actions.untrust();
      manager.reloadCa();
      return { ok: true, lines, ca: await manager.caStatus() };
    }
    const requested = Array.isArray(domains) ? domains.filter((d): d is string => typeof d === "string") : [];
    const current = manager.settings().ca_suffixes;
    let suffixes: string[];
    try {
      suffixes = mergeSuffixList(current, requested);
    } catch (err) {
      if (err instanceof HostnameError) throw new ManagerError("invalid", err.message);
      throw err;
    }
    const { lines } = await actions.trust(suffixes);
    if (JSON.stringify(suffixes) !== JSON.stringify(current)) await manager.updateSettings({ ca_suffixes: suffixes });
    manager.reloadCa();
    return { ok: true, lines, ca: await manager.caStatus() };
  };

  const route = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const caller = callerOf(req.headers);
    const fromAgent = caller.client === "mcp";
    const forbidAgent = (what: string): void => {
      if (fromAgent) throw new ManagerError("forbidden", `${what} is not available to agents; ask the person to do it`);
    };
    /** Run the action now, or queue it for approval when an agent asks for something gated. */
    const run = async (gate: Gate | undefined, action: () => Promise<unknown>, okStatus = 200): Promise<Response> => {
      if (gate && fromAgent && manager.settings().agent_approvals === "required") {
        return json(approvals.create({ agent: caller.agent ?? "an unnamed agent", ...gate, run: action }), 202);
      }
      return json(await action(), okStatus);
    };
    const directory = (): Directory => opts.directory ?? unavailable("the server directory");

    if (path === "/v1/status" && method === "GET") return json(await status());
    if (path === "/v1/settings") {
      if (method === "GET") return json(manager.settings());
      if (method === "PATCH") {
        forbidAgent("changing settings");
        return json(await manager.updateSettings(await readBody(req)));
      }
    }
    if (path === "/v1/hosts" && method === "GET") {
      return json({ entries: manager.hostEntries(), helper: await manager.hostsStatus() });
    }
    if (path === "/v1/hosts/sync" && method === "POST") {
      const helper = await manager.syncHosts();
      return json({ entries: manager.hostEntries(), helper });
    }
    if (path === "/v1/ca/reload" && method === "POST") {
      manager.reloadCa();
      return json(await manager.caStatus());
    }
    const ca = /^\/v1\/ca\/(trust|untrust)$/.exec(path);
    if (ca && method === "POST") {
      const verb = ca[1] as "trust" | "untrust";
      const body = objectOf(await readBody(req));
      return run(gateCa(verb), () => caAction(verb, body["domains"]));
    }
    if (path === "/v1/events" && method === "GET") return events();
    if (path === "/v1/shutdown" && method === "POST") {
      setImmediate(opts.onShutdown);
      return json({ ok: true });
    }
    if (path === "/v1/auth/login" && method === "POST") {
      const profile = objectOf(await readBody(req))["profile"];
      return startLogin(typeof profile === "string" ? profile : undefined);
    }
    if (path === "/v1/orgs" && method === "GET") return json({ orgs: await directory().orgs() });
    const orgRoute = /^\/v1\/orgs\/([^/]+)\/servers(?:\/([^/]+)\/ports)?$/.exec(path);
    if (orgRoute && method === "GET") {
      const org = decodeURIComponent(orgRoute[1] ?? "");
      const server = orgRoute[2];
      if (server === undefined) return json({ servers: await directory().servers(org) });
      return json({ ports: await directory().ports(org, decodeURIComponent(server)) });
    }
    if (path === "/v1/approvals" && method === "GET") {
      const all = url.searchParams.get("all");
      return json({ approvals: approvals.list({ all: all === "true" || all === "1" }) });
    }
    const approval = /^\/v1\/approvals\/([^/]+)(?:\/(approve|deny))?$/.exec(path);
    if (approval) {
      const id = decodeURIComponent(approval[1] ?? "");
      const decision = approval[2];
      if (!decision && method === "GET") return json(approvals.get(id));
      if (decision && method === "POST") {
        forbidAgent("deciding an approval");
        return json(decision === "approve" ? await approvals.approve(id) : approvals.deny(id));
      }
    }
    if (path === "/v1/foreground" && method === "GET") return json({ tunnels: foreground.list() });
    const stopForegroundRoute = /^\/v1\/foreground\/([^/]+)\/stop$/.exec(path);
    if (stopForegroundRoute && method === "POST") {
      forbidAgent("stopping a tunnel in someone's terminal");
      try {
        await foreground.stop(decodeURIComponent(stopForegroundRoute[1] ?? ""));
      } catch (err) {
        if (err instanceof ForegroundNotFound) throw new ManagerError("not_found", err.message);
        throw err;
      }
      return json({ ok: true });
    }
    if (path === "/v1/tunnels/open" && method === "POST") {
      const request = parseOpenRequest(await readBody(req));
      const resolved = await directory().resolve({ org: request.org, server: request.server, profile: request.profile });
      return json(
        await manager.openAdHoc({ ...resolved, target: request.target, kind: request.kind, ttl_minutes: request.ttl_minutes }),
        201,
      );
    }
    if (path === "/v1/tunnels") {
      if (method === "GET") return json({ tunnels: manager.list() });
      if (method === "POST") {
        const body = await readBody(req);
        return run(gateAdd(body), () => manager.add(body), 201);
      }
    }
    const m = /^\/v1\/tunnels\/([^/]+)(?:\/(up|down|share))?$/.exec(path);
    if (m) {
      const name = decodeURIComponent(m[1] ?? "");
      const action = m[2];
      if (action === "up" && method === "POST") {
        const body = objectOf(await readBody(req));
        return run(gateUp(manager.get(name)), () => manager.up(name, { verify: body["verify"] === true }));
      }
      if (action === "down" && method === "POST") return json(await manager.down(name));
      if (action === "share" && method === "POST") {
        const body = objectOf(await readBody(req));
        return run(gateShare(manager.get(name), body), () => manager.share(name, body));
      }
      if (action === "share" && method === "DELETE") {
        return run(gateUnshare(manager.get(name)), () => manager.unshare(name));
      }
      if (!action && method === "GET") return json(manager.get(name));
      if (!action && method === "PATCH") {
        const body = await readBody(req);
        return run(gateEdit(manager.get(name), body), () => manager.edit(name, body));
      }
      if (!action && method === "DELETE") {
        return run(gateRemove(manager.get(name)), async () => {
          await manager.remove(name);
          return { ok: true };
        });
      }
    }
    return fail(404, "not_found", `no route for ${method} ${path}`);
  };

  const server = Bun.serve({
    unix: opts.socketPath,
    async fetch(req, srv) {
      // The event stream is long-lived, opening an ad-hoc tunnel waits for a session, and approving
      // runs a slow action: keep Bun's idle timer from closing any of them.
      srv.timeout(req, 0);
      const caller = callerOf(req.headers);
      const client = caller.agent ? `${caller.client} (${caller.agent})` : caller.client;
      try {
        const res = await route(req);
        if (req.method !== "GET") opts.log(`${req.method} ${new URL(req.url).pathname} from ${client} -> ${res.status}`);
        return res;
      } catch (err) {
        if (err instanceof ManagerError) {
          opts.log(`${req.method} ${new URL(req.url).pathname} from ${client} -> ${STATUS_FOR[err.code]} ${err.message}`);
          return fail(STATUS_FOR[err.code], err.code, err.message, err.state);
        }
        const message = err instanceof Error ? err.message : String(err);
        opts.log(`${req.method} ${new URL(req.url).pathname} from ${client} -> 500 ${message}`);
        return fail(500, "internal", message);
      }
    },
  });
  chmodSync(opts.socketPath, 0o600);

  return {
    approvals,
    async stop() {
      for (const close of [...closers]) close();
      approvals.stop();
      await server.stop();
      rmSync(opts.socketPath, { force: true });
    },
  };
}
