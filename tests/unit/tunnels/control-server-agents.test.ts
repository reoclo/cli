import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalView } from "../../../src/tunnels/approvals";
import type { AuthEvent, AuthFlow } from "../../../src/tunnels/auth-flow";
import type { CaActions } from "../../../src/tunnels/ca-actions";
import { ControlClient, type DaemonError } from "../../../src/tunnels/control-client";
import { startControlServer, type ControlServer, type ControlServerOptions } from "../../../src/tunnels/control-server";
import { ManagerError, TunnelManager, type TunnelView } from "../../../src/tunnels/manager";
import { PoolError } from "../../../src/tunnels/pool";
import { FakePool, ManualTimers } from "../../helpers/fake-pool";
import { readUntil } from "../../helpers/events";
import { FakeDirectory } from "../../helpers/fake-directory";
import { freePort } from "../../helpers/fake-ws-gateway";
import { rejectionOf } from "../../helpers/rejection";

class FakeAuth implements AuthFlow {
  started: Array<{ profile?: string }> = [];
  finish!: (e: AuthEvent) => void;
  fail!: (e: Error) => void;
  login(opts: { profile?: string }, onCode: (e: AuthEvent) => void): Promise<AuthEvent> {
    this.started.push(opts);
    onCode({
      status: "pending",
      user_code: "ABCD-1234",
      verification_uri: "https://auth.test/device",
      verification_uri_complete: "https://auth.test/device?user_code=ABCD-1234",
      expires_in: 900,
    });
    return new Promise((resolve, reject) => {
      this.finish = resolve;
      this.fail = reject;
    });
  }
}

let dir: string;
let socket: string;
let manager: TunnelManager;
let server: ControlServer;
let cli: ControlClient;
let agent: ControlClient;
let pool: FakePool;
let directory: FakeDirectory;
let auth: FakeAuth;
let approvalTimers: ManualTimers;
let caCalls: Array<[string, string[]?]>;
let ids: number;

const caActions: CaActions = {
  trust(suffixes) {
    caCalls.push(["trust", suffixes]);
    return Promise.resolve({ lines: ["trusted the local CA"], suffixes: ["reoclo.localhost", ...suffixes] });
  },
  untrust() {
    caCalls.push(["untrust"]);
    return Promise.resolve({ lines: ["removed the local CA"] });
  },
};

function boot(extra: Partial<ControlServerOptions> = {}): ControlServer {
  return startControlServer({
    socketPath: socket,
    manager,
    version: "9.9.9",
    startedAt: Date.now(),
    stateDir: dir,
    log: () => undefined,
    onShutdown: () => undefined,
    trafficIntervalMs: 20,
    directory,
    auth,
    caActions,
    approvals: { timers: approvalTimers, newId: () => `ap${++ids}` },
    ...extra,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-agents-"));
  socket = join(dir, "run", "tunneld.sock");
  pool = new FakePool();
  directory = new FakeDirectory();
  auth = new FakeAuth();
  approvalTimers = new ManualTimers();
  caCalls = [];
  ids = 0;
  manager = new TunnelManager({ configPath: join(dir, "tunnels.yaml"), createPool: () => pool });
  server = boot();
  cli = new ControlClient(socket);
  agent = new ControlClient(socket, { client: "mcp", agent: "claude-code" });
});
afterEach(async () => {
  await server.stop();
  await manager.stop();
  rmSync(dir, { recursive: true, force: true });
});

const base = { org: "acme", tenant_id: "t1", server: "prod-1", server_id: "s1" };
const forward = async (name: string, extra: Record<string, unknown> = {}) => ({
  ...base,
  name,
  kind: "tcp",
  target: "127.0.0.1:5432",
  local_port: await freePort(),
  ...extra,
});
const reverse = (name = "hook", extra: Record<string, unknown> = {}) => ({
  ...base,
  name,
  kind: "reverse",
  remote_port: 8080,
  local_target: "127.0.0.1:3000",
  ...extra,
});

async function failure(p: Promise<unknown>): Promise<DaemonError> {
  return (await rejectionOf(p)) as DaemonError;
}

describe("directory routes", () => {
  it("lists organizations, servers and the stored port scan", async () => {
    expect(await cli.orgs()).toEqual([{ id: "t1", slug: "acme", name: "Acme" }]);
    expect((await cli.servers("acme"))[0]).toMatchObject({ id: "s1", slug: "prod-1", connection_type: "runner" });
    expect(await cli.ports("acme", "prod-1")).toEqual([
      { port: 5432, protocol: "tcp", bind_address: "127.0.0.1", process: "postgres" },
    ]);
    expect(directory.calls).toEqual(["orgs", "servers acme", "ports acme prod-1"]);
  });

  it("answers the status codes of a directory failure", async () => {
    directory.failWith = new ManagerError("unauthorized", "sign-in expired", "needs_sign_in");
    expect(await failure(cli.orgs())).toMatchObject({ status: 401, code: "unauthorized", state: "needs_sign_in" });
    directory.failWith = new ManagerError("not_found", "organization 'x' not found");
    expect(await failure(cli.servers("x"))).toMatchObject({ status: 404, code: "not_found" });
    directory.failWith = new ManagerError("forbidden", "refused", "forbidden");
    expect(await failure(cli.orgs())).toMatchObject({ status: 403 });
  });

  it("answers 502 when the daemon has no directory", async () => {
    await server.stop();
    server = boot({ directory: undefined });
    expect(await failure(cli.orgs())).toMatchObject({ status: 502, code: "upstream" });
  });

  it("reports whether a profile is signed in", async () => {
    expect((await cli.status()).signed_in).toBe(true);
    directory.signed = false;
    expect((await cli.status()).signed_in).toBe(false);
  });
});

describe("ad-hoc open", () => {
  it("resolves the server, opens a tunnel and lists it with its expiry", async () => {
    const view = await cli.openAdHoc({ server: "prod-1", org: "acme", target: "5432", ttl_minutes: 10 });
    expect(view).toMatchObject({ adhoc: true, kind: "tcp", target: "127.0.0.1:5432", server: "prod-1", state: "ready" });
    expect(Date.parse(view.expires_at ?? "") - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(directory.calls).toEqual(["resolve acme prod-1"]);
    expect(pool.acquired).toEqual(["stream"]);
    expect((await cli.tunnels()).map((t) => t.name)).toEqual([view.name]);
    await cli.down(view.name);
    expect(await cli.tunnels()).toEqual([]);
  });

  it("lets an agent open one without approval", async () => {
    const view = await agent.openAdHoc({ server: "prod-1", org: "acme", target: "127.0.0.1:6379" });
    expect(view.adhoc).toBe(true);
    expect(await cli.approvals(true)).toEqual([]);
  });

  it("rejects a malformed request", async () => {
    const bad = (body: Record<string, unknown>) => failure(cli.openAdHoc(body));
    expect(await bad({ org: "acme", target: "5432" })).toMatchObject({ status: 400, code: "invalid" });
    expect(await bad({ server: "prod-1", target: "5432" })).toMatchObject({ status: 400 });
    expect(await bad({ server: "prod-1", org: "acme" })).toMatchObject({ status: 400 });
    expect(await bad({ server: "prod-1", org: "acme", target: "5432", kind: "https" })).toMatchObject({ status: 400 });
    expect(await bad({ server: "prod-1", org: "acme", target: "5432", ttl_minutes: "10" })).toMatchObject({ status: 400 });
    expect(await bad({ server: "prod-1", org: "acme", target: "5432", ttl_minutes: 481 })).toMatchObject({ status: 400 });
  });

  it("answers 401 when the session cannot open, and keeps no tunnel", async () => {
    pool.error = new PoolError("needs_sign_in", "sign-in expired");
    const err = await failure(cli.openAdHoc({ server: "prod-1", org: "acme", target: "5432" }));
    expect(err).toMatchObject({ status: 401, code: "unauthorized", state: "needs_sign_in" });
    expect(await cli.tunnels()).toEqual([]);
  });

  it("verifies a saved tunnel's connection on up when asked", async () => {
    await cli.add(await forward("db", { enabled: false }));
    await cli.request("POST", "/v1/tunnels/db/up", { verify: true });
    expect(pool.acquired).toEqual(["stream"]);
    expect(pool.released).toEqual(["stream"]);
  });
});

describe("agent approvals", () => {
  it("runs a plain tunnel from an agent without asking", async () => {
    const reply = await agent.requestWithStatus<TunnelView>("POST", "/v1/tunnels", await forward("db"));
    expect(reply.status).toBe(201);
    expect(reply.body.name).toBe("db");
  });

  it("queues a reverse tunnel from an agent, and runs it when a person approves", async () => {
    const reply = await agent.requestWithStatus<ApprovalView>("POST", "/v1/tunnels", reverse());
    expect(reply.status).toBe(202);
    expect(reply.body).toMatchObject({ id: "ap1", agent: "claude-code", action: "save_tunnel", status: "pending" });
    expect(await cli.tunnels()).toEqual([]);

    expect((await cli.approvals()).map((a) => a.id)).toEqual(["ap1"]);
    expect((await cli.approval("ap1")).description).toContain("reverse tunnel");

    const done = await cli.approve("ap1");
    expect(done.status).toBe("approved");
    expect(done.result).toMatchObject({ name: "hook", kind: "reverse" });
    expect((await cli.tunnels()).map((t) => t.name)).toEqual(["hook"]);
    expect(await cli.approvals()).toEqual([]);
    expect((await cli.approvals(true)).map((a) => a.status)).toEqual(["approved"]);
  });

  it("does not run a denied request", async () => {
    await agent.requestWithStatus("POST", "/v1/tunnels", reverse());
    expect((await cli.deny("ap1")).status).toBe("denied");
    expect(await cli.tunnels()).toEqual([]);
    expect(await failure(cli.approve("ap1"))).toMatchObject({ status: 409, code: "conflict" });
  });

  it("refuses to let an agent decide an approval or change settings", async () => {
    await agent.requestWithStatus("POST", "/v1/tunnels", reverse());
    expect(await failure(agent.approve("ap1"))).toMatchObject({ status: 403, code: "forbidden" });
    expect(await failure(agent.deny("ap1"))).toMatchObject({ status: 403 });
    expect(await failure(agent.updateSettings({ agent_approvals: "off" }))).toMatchObject({ status: 403 });
    expect((await cli.approvals()).map((a) => a.status)).toEqual(["pending"]);
    expect((await agent.settings()).agent_approvals).toBe("required");
  });

  it("changes settings for the app and the CLI", async () => {
    const next = await cli.updateSettings({ agent_approvals: "off", idle_timeout_seconds: 30 });
    expect(next).toMatchObject({ agent_approvals: "off", idle_timeout_seconds: 30 });
    expect(await failure(cli.updateSettings({ agent_approvals: "maybe" as "off" }))).toMatchObject({ status: 400 });
  });

  it("runs everything directly when agent approvals are off", async () => {
    await cli.updateSettings({ agent_approvals: "off" });
    const reply = await agent.requestWithStatus<TunnelView>("POST", "/v1/tunnels", reverse());
    expect(reply.status).toBe(201);
    expect(await cli.approvals(true)).toEqual([]);
  });

  it("does not gate the CLI or the app", async () => {
    expect((await cli.requestWithStatus("POST", "/v1/tunnels", reverse())).status).toBe(201);
    const app = new ControlClient(socket, { client: "app" });
    expect((await app.requestWithStatus("POST", "/v1/tunnels", reverse("hook-2", { remote_port: 8081 }))).status).toBe(201);
  });

  it("gates a hostname change and a hostname removal, not plain edits", async () => {
    await cli.add(await forward("db", { hostname: "db.prod-1.reoclo.localhost" }));
    expect((await agent.requestWithStatus("PATCH", "/v1/tunnels/db", { target: "10.0.0.1:80" })).status).toBe(200);
    expect((await agent.requestWithStatus("PATCH", "/v1/tunnels/db", { hostname: "other.prod-1.reoclo.localhost" })).status).toBe(202);
    expect((await agent.requestWithStatus("DELETE", "/v1/tunnels/db")).status).toBe(202);
    expect((await cli.tunnel("db")).hostname).toBe("db.prod-1.reoclo.localhost");

    await cli.add(await forward("plain"));
    expect((await agent.requestWithStatus("DELETE", "/v1/tunnels/plain")).status).toBe(200);
  });

  it("gates bringing up a reverse tunnel and runs it on approval", async () => {
    await cli.add(reverse("hook", { enabled: false }));
    const reply = await agent.requestWithStatus<ApprovalView>("POST", "/v1/tunnels/hook/up", { verify: true });
    expect(reply.status).toBe(202);
    expect(reply.body.action).toBe("open_tunnel");
    expect((await cli.tunnel("hook")).enabled).toBe(false);
    await cli.approve(reply.body.id);
    expect((await cli.tunnel("hook")).enabled).toBe(true);
  });

  it("never gates closing", async () => {
    await cli.add(reverse());
    expect((await agent.requestWithStatus("POST", "/v1/tunnels/hook/down")).status).toBe(200);
  });

  it("answers 404 for a tunnel that does not exist before asking anyone", async () => {
    expect(await failure(agent.request("PATCH", "/v1/tunnels/nope", { target: "1.1.1.1:1" }))).toMatchObject({ status: 404 });
    expect(await cli.approvals(true)).toEqual([]);
  });

  it("records the approved request's failure on the approval", async () => {
    await cli.add(reverse("hook", { enabled: false }));
    const reply = await agent.requestWithStatus<ApprovalView>("POST", "/v1/tunnels/hook/up");
    await cli.remove("hook");
    const done = await cli.approve(reply.body.id);
    expect(done.status).toBe("approved");
    expect(done.error).toMatchObject({ code: "not_found" });
  });

  it("expires an unanswered request", async () => {
    await agent.requestWithStatus("POST", "/v1/tunnels", reverse());
    approvalTimers.fire();
    expect((await cli.approval("ap1")).status).toBe("expired");
    expect(await cli.approvals()).toEqual([]);
    expect(await failure(cli.approve("ap1"))).toMatchObject({ status: 409 });
  });

  it("names an agent that sent no name", async () => {
    const res = await fetch("http://localhost/v1/tunnels", {
      unix: socket,
      method: "POST",
      headers: { "x-reoclo-client": "mcp", "content-type": "application/json" },
      body: JSON.stringify(reverse()),
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as ApprovalView).agent).toBe("an unnamed agent");
  });

  it("answers 404 for an unknown approval", async () => {
    expect(await failure(cli.approval("nope"))).toMatchObject({ status: 404 });
    expect(await failure(cli.approve("nope"))).toMatchObject({ status: 404 });
  });

  it("publishes an approval event when a request arrives and when it is decided", async () => {
    const res = await fetch("http://localhost/v1/events", { unix: socket });
    const arrived = readUntil(res, '"status":"pending"');
    await agent.requestWithStatus("POST", "/v1/tunnels", reverse());
    const text = await arrived;
    expect(text).toContain("event: approval");
    expect(text).toContain('"approvals":[');
    expect(text).toContain('"agent":"claude-code"');

    const res2 = await fetch("http://localhost/v1/events", { unix: socket });
    const decided = readUntil(res2, '"status":"approved"');
    await cli.approve("ap1");
    const after = await decided;
    expect(after).toContain("event: approval");
    expect(after).toContain('"approvals":[]');
  });

  it("lets an agent wait for the decision on the event stream", async () => {
    const reply = await agent.requestWithStatus<ApprovalView>("POST", "/v1/tunnels", reverse());
    const waiting = agent.waitForApproval(reply.body.id, AbortSignal.timeout(5000));
    await cli.approve(reply.body.id);
    expect((await waiting)?.status).toBe("approved");
  });

  it("returns the decision at once when it was made before the wait began", async () => {
    const reply = await agent.requestWithStatus<ApprovalView>("POST", "/v1/tunnels", reverse());
    await cli.deny(reply.body.id);
    expect((await agent.waitForApproval(reply.body.id, AbortSignal.timeout(5000)))?.status).toBe("denied");
  });

  it("stops waiting when the signal aborts", async () => {
    const reply = await agent.requestWithStatus<ApprovalView>("POST", "/v1/tunnels", reverse());
    const stop = new AbortController();
    const waiting = agent.waitForApproval(reply.body.id, stop.signal);
    stop.abort();
    expect(await waiting).toBeUndefined();
    expect((await cli.approval(reply.body.id)).status).toBe("pending");
  });
});

describe("certificate authority routes", () => {
  it("trusts the CA with merged suffixes and remembers them", async () => {
    const res = await cli.request<{ ok: boolean; lines: string[] }>("POST", "/v1/ca/trust", { domains: ["internal"] });
    expect(res).toMatchObject({ ok: true, lines: ["trusted the local CA"] });
    expect(caCalls).toEqual([["trust", ["internal"]]]);
    expect((await cli.settings()).ca_suffixes).toEqual(["internal"]);
  });

  it("rejects an invalid suffix", async () => {
    expect(await failure(cli.request("POST", "/v1/ca/trust", { domains: ["com"] }))).toMatchObject({ status: 400, code: "invalid" });
    expect(caCalls).toEqual([]);
  });

  it("untrusts the CA", async () => {
    expect(await cli.request("POST", "/v1/ca/untrust")).toMatchObject({ ok: true, lines: ["removed the local CA"] });
    expect(caCalls).toEqual([["untrust"]]);
  });

  it("holds an agent's trust request until a person approves it", async () => {
    const reply = await agent.requestWithStatus<ApprovalView>("POST", "/v1/ca/trust", {});
    expect(reply.status).toBe(202);
    expect(reply.body.action).toBe("trust_ca");
    expect(caCalls).toEqual([]);
    await cli.approve(reply.body.id);
    expect(caCalls).toEqual([["trust", []]]);
  });

  it("answers 502 when the daemon cannot change trust", async () => {
    await server.stop();
    server = boot({ caActions: undefined });
    expect(await failure(cli.request("POST", "/v1/ca/trust", {}))).toMatchObject({ status: 502 });
  });
});

describe("sign-in", () => {
  it("starts the device flow and streams the code, then the result", async () => {
    const res = await fetch("http://localhost/v1/events", { unix: socket });
    const events = readUntil(res, '"status":"success"');
    expect(await cli.requestWithStatus("POST", "/v1/auth/login", {})).toMatchObject({ status: 202, body: { ok: true } });
    expect(await failure(cli.request("POST", "/v1/auth/login", {}))).toMatchObject({ status: 409, code: "conflict" });
    auth.finish({ status: "success", email: "dev@example.com", profile: "default" });
    const text = await events;
    expect(text).toContain("event: auth");
    expect(text).toContain('"user_code":"ABCD-1234"');
    expect(text.indexOf('"status":"pending"')).toBeLessThan(text.indexOf('"status":"success"'));
    expect(text).toContain('"email":"dev@example.com"');
  });

  it("reports a failed sign-in and allows another", async () => {
    const res = await fetch("http://localhost/v1/events", { unix: socket });
    const events = readUntil(res, '"status":"failed"');
    await cli.request("POST", "/v1/auth/login", { profile: "work" });
    auth.fail(new Error("authorization cancelled by user"));
    expect(await events).toContain("authorization cancelled by user");
    expect(auth.started).toEqual([{ profile: "work" }]);

    expect((await cli.requestWithStatus("POST", "/v1/auth/login", {})).status).toBe(202);
    expect(auth.started).toHaveLength(2);
  });

  it("answers 502 when the daemon cannot sign in", async () => {
    await server.stop();
    server = boot({ auth: undefined });
    expect(await failure(cli.request("POST", "/v1/auth/login", {}))).toMatchObject({ status: 502 });
  });
});
