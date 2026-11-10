import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { applyVerbAliases } from "../../../src/lib/verb-aliases";
import { registerTunnel } from "../../../src/commands/tunnel";
import {
  buildAddBody,
  buildEditBody,
  formatSavedTunnels,
  detailFor,
  httpsHints,
  parseHostnameFlag,
  parseHostPortFlag,
  parsePortFlag,
  parseViaFlag,
  sharedLabel,
  slugLabel,
  tailnetWarnings,
  UsageError,
} from "../../../src/commands/tunnel-saved";
import { describeStatus, lastLines } from "../../../src/commands/tunnel-daemon";
import { daemonCommand } from "../../../src/tunnels/control-client";
import type { TunnelView } from "../../../src/tunnels/manager";

const ctx = { org: "acme", tenant_id: "t1", profile: "default", server: "prod-1", server_id: "s1" };

describe("flag parsing", () => {
  it("turns a bare port into a loopback target", () => {
    expect(parseHostPortFlag("--target", "5432")).toBe("127.0.0.1:5432");
    expect(parseHostPortFlag("--target", "db.internal:5432")).toBe("db.internal:5432");
  });
  it("rejects bad targets and ports with a usage error", () => {
    for (const v of ["", "db:", ":5432", "db:99999", "db:0", "a b:1"]) {
      expect(() => parseHostPortFlag("--target", v)).toThrow(UsageError);
    }
    expect(() => parsePortFlag("--local-port", "70000")).toThrow(/invalid --local-port/);
    expect(() => parsePortFlag("--local-port", "abc")).toThrow(UsageError);
  });
});

describe("buildAddBody", () => {
  it("builds a forward tunnel that is up by default", () => {
    expect(buildAddBody("prod-db", { target: "5432", up: true }, ctx)).toEqual({
      name: "prod-db",
      org: "acme",
      tenant_id: "t1",
      profile: "default",
      server: "prod-1",
      server_id: "s1",
      kind: "tcp",
      keep_up: false,
      enabled: true,
      target: "127.0.0.1:5432",
    });
  });
  it("honours --local-port, --keep-up, --no-up and --kind udp", () => {
    const body = buildAddBody("dns", { kind: "udp", target: "10.0.0.2:53", localPort: "5353", keepUp: true, up: false }, ctx);
    expect(body).toMatchObject({ kind: "udp", local_port: 5353, keep_up: true, enabled: false });
  });
  it("builds a reverse tunnel", () => {
    const body = buildAddBody("hook", { kind: "reverse", remotePort: "8080", localTarget: "3000", bindPublic: true }, ctx);
    expect(body).toMatchObject({ kind: "reverse", remote_port: 8080, local_target: "127.0.0.1:3000", bind_public: true });
    expect(body).not.toHaveProperty("target");
  });
  it("requires the flags its kind needs", () => {
    expect(() => buildAddBody("a", {}, ctx)).toThrow(/needs --target/);
    expect(() => buildAddBody("a", { kind: "reverse", localTarget: "3000" }, ctx)).toThrow(/--remote-port/);
    expect(() => buildAddBody("a", { kind: "reverse", remotePort: "80" }, ctx)).toThrow(/--local-target/);
  });
  it("rejects flags that belong to the other kind", () => {
    expect(() => buildAddBody("a", { target: "5432", remotePort: "80" }, ctx)).toThrow(/--remote-port does not apply/);
    expect(() => buildAddBody("a", { kind: "reverse", remotePort: "80", localTarget: "1", target: "5" }, ctx)).toThrow(/--target does not apply/);
  });
  it("rejects an unknown kind", () => {
    expect(() => buildAddBody("a", { kind: "icmp", target: "80" }, ctx)).toThrow(/expected tcp, udp, https, reverse or local/);
  });
  it("marks usage errors with exit code 2", () => {
    try {
      buildAddBody("a", {}, ctx);
    } catch (e) {
      expect((e as UsageError).exitCode).toBe(2);
    }
  });
});

describe("https tunnels", () => {
  it("defaults the hostname to <tunnel>.<server>.reoclo.localhost", () => {
    const body = buildAddBody("grafana", { kind: "https", target: "3000" }, { ...ctx, server: "Prod 1" });
    expect(body).toMatchObject({ kind: "https", target: "127.0.0.1:3000", hostname: "grafana.prod-1.reoclo.localhost" });
    expect(body).not.toHaveProperty("local_port");
  });

  it("becomes the default kind when --hostname is given", () => {
    const body = buildAddBody("g", { hostname: "Grafana.Internal", target: "3000" }, ctx);
    expect(body).toMatchObject({ kind: "https", hostname: "grafana.internal" });
  });

  it("keeps tcp the default without a hostname, and a tcp hostname is optional", () => {
    expect(buildAddBody("db", { target: "5432" }, ctx)).toMatchObject({ kind: "tcp" });
    expect(buildAddBody("db", { target: "5432" }, ctx)).not.toHaveProperty("hostname");
    expect(buildAddBody("db", { kind: "tcp", target: "5432", hostname: "db.reoclo.localhost" }, ctx)).toMatchObject({ hostname: "db.reoclo.localhost" });
  });

  it("rejects a local port, a bad hostname and reverse flags", () => {
    expect(() => buildAddBody("g", { kind: "https", target: "80", localPort: "9000" }, ctx)).toThrow(/--local-port does not apply to a https tunnel/);
    expect(() => buildAddBody("g", { kind: "https", target: "80", hostname: "not a host" }, ctx)).toThrow(/invalid --hostname/);
    expect(() => buildAddBody("g", { kind: "https" }, ctx)).toThrow(/needs --target/);
    expect(() => buildAddBody("g", { kind: "https", target: "80", remotePort: "80" }, ctx)).toThrow(/--remote-port does not apply/);
    expect(() => buildAddBody("h", { kind: "reverse", remotePort: "80", localTarget: "1", hostname: "h.reoclo.localhost" }, ctx)).toThrow(/--hostname does not apply/);
  });

  it("turns a server name into one DNS label", () => {
    expect(slugLabel("Prod 1")).toBe("prod-1");
    expect(slugLabel("db_01.eu-west")).toBe("db-01-eu-west");
    expect(slugLabel("--")).toBe("server");
    expect(slugLabel("a".repeat(80))).toHaveLength(63);
    expect(parseHostnameFlag(" A.Internal ")).toBe("a.internal");
  });

  it("allows --hostname on an edit of a tcp or https tunnel, and not --local-port on https", () => {
    expect(buildEditBody("https", { hostname: "x.reoclo.localhost", target: "81" })).toEqual({ hostname: "x.reoclo.localhost", target: "127.0.0.1:81" });
    expect(buildEditBody("tcp", { hostname: "x.reoclo.localhost" })).toEqual({ hostname: "x.reoclo.localhost" });
    expect(() => buildEditBody("https", { localPort: "9000" })).toThrow(UsageError);
    expect(() => buildEditBody("reverse", { hostname: "x.reoclo.localhost" })).toThrow(UsageError);
  });

  it("shows the URL in the LOCAL column and the summary", () => {
    const view = { name: "g", kind: "https", url: "https://g.prod-1.reoclo.localhost:8443", state: "ready", action: "None" } as TunnelView;
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string) => (lines.push(s), true);
    try {
      formatSavedTunnels([view], "json");
    } finally {
      process.stdout.write = write;
    }
    expect((JSON.parse(lines.join("")) as { url: string }).url).toBe("https://g.prod-1.reoclo.localhost:8443");
  });

  it("hints at trust and the hosts helper only when they are missing", () => {
    const caOk = { exists: true, trusted: true, suffixes: ["reoclo.localhost"], stale: false };
    const helperOk = { installed: true, entries: 1, suffixes: [], relay: { enabled: false, listening: false } };
    expect(httpsHints({ ca: caOk, hosts: helperOk })).toEqual([]);
    expect(httpsHints({ ca: { ...caOk, trusted: false }, hosts: helperOk })[0]).toMatch(/reoclo tunnel trust/);
    expect(httpsHints({ ca: { ...caOk, exists: false, trusted: false }, hosts: helperOk })[0]).toMatch(/reoclo tunnel trust/);
    expect(httpsHints({ ca: { ...caOk, stale: true }, hosts: helperOk })).toHaveLength(1);
    expect(httpsHints({ ca: { ...caOk, stale: true }, hosts: helperOk })[0]).toMatch(/reoclo tunnel trust/);
    expect(httpsHints({ ca: caOk, hosts: { ...helperOk, installed: false } })[0]).toMatch(/reoclo hosts setup/);
  });
});

describe("buildEditBody", () => {
  it("includes only what was passed", () => {
    expect(buildEditBody("tcp", { target: "6379", keepUp: false })).toEqual({ target: "127.0.0.1:6379", keep_up: false });
    expect(buildEditBody("tcp", {})).toEqual({});
  });
  it("rejects flags of the other kind", () => {
    expect(() => buildEditBody("tcp", { remotePort: "80" })).toThrow(UsageError);
    expect(() => buildEditBody("reverse", { localPort: "80" })).toThrow(UsageError);
  });
  it("allows --no-bind-public on a reverse tunnel", () => {
    expect(buildEditBody("reverse", { bindPublic: false })).toEqual({ bind_public: false });
  });
});

describe("detailFor", () => {
  const view = (o: Partial<TunnelView>): TunnelView =>
    ({ name: "prod-db", state: "ready", action: "None", message: "m", ...o }) as TunnelView;
  it("prefers the daemon's detail", () => {
    expect(detailFor(view({ state: "failed", detail: "local port 15432 is already in use" }))).toBe("local port 15432 is already in use");
  });
  it("falls back to the suggested action with the tunnel name filled in", () => {
    expect(detailFor(view({ state: "expired", action: "Run reoclo tunnel up <name>" }))).toBe("Run reoclo tunnel up prod-db");
  });
  it("is empty when nothing needs doing", () => {
    expect(detailFor(view({}))).toBe("");
  });
});

describe("daemon command helpers", () => {
  it("re-runs a compiled binary on its own", () => {
    expect(daemonCommand("/usr/local/bin/reoclo", "/$bunfs/root/reoclo")).toEqual({
      cmd: "/usr/local/bin/reoclo",
      args: ["tunnel", "daemon", "run"],
    });
  });
  it("passes the script path in dev", () => {
    expect(daemonCommand("/bin/bun", "/repo/src/index.ts")).toEqual({
      cmd: "/bin/bun",
      args: ["/repo/src/index.ts", "tunnel", "daemon", "run"],
    });
  });
  it("keeps the last lines of a log", () => {
    expect(lastLines("a\nb\nc\n", 2)).toBe("b\nc");
    expect(lastLines("a\nb", 5)).toBe("a\nb");
    expect(lastLines("", 3)).toBe("");
  });
  it("summarises only the states that have tunnels", () => {
    const out = describeStatus({
      version: "1",
      pid: 7,
      uptime_seconds: 3,
      state_dir: "/s",
      socket: "/s/run/x",
      tunnels: { total: 2, enabled: 1, by_state: { ready: 1, down: 1, active: 0 } },
    });
    expect(out).toMatchObject({ running: true, pid: 7, tunnels: 2, enabled: 1, state_ready: 1, state_down: 1 });
    expect(out).not.toHaveProperty("state_active");
    expect(out).not.toHaveProperty("executable");
    expect(out).not.toHaveProperty("ca_exists");
  });
  it("adds the HTTPS listener, the CA and the hosts helper when the daemon reports them", () => {
    const out = describeStatus({
      version: "1",
      executable: "/opt/homebrew/bin/reoclo",
      pid: 7,
      uptime_seconds: 3,
      state_dir: "/s",
      socket: "/s/run/x",
      tunnels: { total: 0, enabled: 0, by_state: {} },
      https: { port: 8443, listening: false, error: "port 8443 is already in use" },
      ca: { exists: true, trusted: true, suffixes: ["reoclo.localhost"], stale: true, not_after: "2028-11-09T00:00:00.000Z" },
      hosts: { installed: true, version: "0.103.1", entries: 3, suffixes: ["reoclo.test"], relay: { enabled: true, listening: false, port: 8443 } },
    });
    expect(out).toMatchObject({
      executable: "/opt/homebrew/bin/reoclo",
      https_port: 8443,
      https_listening: false,
      https_error: "port 8443 is already in use",
      ca_exists: true,
      ca_trusted: true,
      ca_stale: true,
      ca_suffixes: ["reoclo.localhost"],
      hosts_helper_installed: true,
      hosts_helper_version: "0.103.1",
      hosts_entries: 3,
      hosts_port_443_relay: false,
      hosts_suffixes: ["reoclo.test"],
      hosts_relay_enabled: true,
      hosts_relay_listening: false,
    });
    expect(out).not.toHaveProperty("hosts_error");
  });
});

describe("command registration", () => {
  const program = new Command().exitOverride();
  registerTunnel(program);
  applyVerbAliases(program);
  const tunnel = program.commands.find((c) => c.name() === "tunnel")!;
  const names = (c: Command): string[] => c.commands.map((x) => x.name());

  it("keeps ls, describe and close and adds the saved-tunnel verbs", () => {
    for (const n of ["ls", "describe", "close", "status", "add", "edit", "rm", "up", "down", "daemon", "trust", "untrust", "ca-path"]) {
      expect(names(tunnel)).toContain(n);
    }
  });
  it("registers the daemon verbs", () => {
    const daemon = tunnel.commands.find((c) => c.name() === "daemon")!;
    expect(names(daemon)).toEqual(["run", "start", "stop", "status", "logs", "install", "uninstall"]);
  });
  it("answers to list, remove and delete through the verb-alias layer", () => {
    const find = (n: string) => tunnel.commands.find((c) => c.name() === n || c.aliases().includes(n))?.name();
    expect(find("list")).toBe("ls");
    expect(find("remove")).toBe("rm");
    expect(find("delete")).toBe("rm");
  });
  it("keeps the one-shot -L and -R options on the tunnel command", () => {
    for (const flag of ["--udp", "--bind-public", "--reconnect-deadline"]) {
      expect(tunnel.options.map((o) => o.long)).toContain(flag);
    }
    expect(tunnel.options.some((o) => o.short === "-L")).toBe(true);
  });
});

describe("tailnet transport flags", () => {
  const server = { ...ctx, server_hostname: "prod-1.example.com" };

  it("saves the server's hostname so the daemon can find it on the tailnet", () => {
    expect(buildAddBody("db", { target: "5432" }, server)).toMatchObject({ server_hostname: "prod-1.example.com" });
    expect(buildAddBody("db", { target: "5432" }, ctx)).not.toHaveProperty("server_hostname");
  });

  it("carries --via and --tailnet-host onto tcp, udp and https tunnels", () => {
    for (const kind of ["tcp", "udp", "https"]) {
      expect(buildAddBody("t", { target: "3000", kind, via: "auto", tailnetHost: " box-1 " }, ctx)).toMatchObject({ via: "auto", tailnet_host: "box-1" });
    }
    expect(buildAddBody("db", { target: "5432", via: "reoclo" }, ctx)).toMatchObject({ via: "reoclo" });
    expect(buildAddBody("db", { target: "5432" }, ctx)).not.toHaveProperty("via");
  });

  it("defaults an SSH server to the tailnet, and lets --via say otherwise", () => {
    expect(buildAddBody("db", { target: "5432" }, { ...ctx, connection_type: "ssh" })).toMatchObject({ via: "tailscale" });
    expect(buildAddBody("db", { target: "5432" }, { ...ctx, connection_type: "runner" })).not.toHaveProperty("via");
    expect(buildAddBody("db", { target: "5432", via: "reoclo" }, { ...ctx, connection_type: "ssh" })).toMatchObject({ via: "reoclo" });
  });

  it("rejects a transport the flags cannot mean", () => {
    expect(() => parseViaFlag("wireguard")).toThrow(/expected reoclo, tailscale or auto/);
    expect(() => buildAddBody("db", { target: "5432", tailnetHost: "box" }, ctx)).toThrow(/needs --via tailscale or --via auto/);
    expect(() => buildAddBody("db", { target: "5432", via: "reoclo", tailnetHost: "box" }, ctx)).toThrow(UsageError);
    expect(() => buildAddBody("db", { target: "5432", via: "auto", tailnetHost: " " }, ctx)).toThrow(/must not be empty/);
  });

  it("keeps a reverse tunnel on the relay, even for an SSH server's default", () => {
    const reverse = { kind: "reverse", remotePort: "8080", localTarget: "3000" };
    expect(buildAddBody("hook", { ...reverse, via: "reoclo" }, ctx)).toMatchObject({ kind: "reverse" });
    expect(() => buildAddBody("hook", { ...reverse, via: "tailscale" }, ctx)).toThrow(/only use the relay/);
    expect(() => buildAddBody("hook", { ...reverse, tailnetHost: "box" }, ctx)).toThrow(UsageError);
    expect(buildAddBody("hook", reverse, { ...ctx, connection_type: "ssh" })).not.toHaveProperty("via");
  });

  it("changes the transport on an edit", () => {
    expect(buildEditBody("tcp", { via: "tailscale", tailnetHost: "box-1" })).toEqual({ via: "tailscale", tailnet_host: "box-1" });
    expect(() => buildEditBody("tcp", { via: "nope" })).toThrow(UsageError);
    expect(() => buildEditBody("reverse", { via: "auto" })).toThrow(/only use the relay/);
    expect(() => buildEditBody("reverse", { tailnetHost: "box" })).toThrow(UsageError);
    expect(buildEditBody("reverse", { via: "reoclo" })).toEqual({ via: "reoclo" });
  });
});

describe("tailnetWarnings", () => {
  const scan = (bind: string) => ({ ports: () => Promise.resolve([{ port: 5432, protocol: "tcp", bind_address: bind, process: "postgres" }]) });
  const body = (extra: Record<string, unknown>) => ({ org: "acme", server_id: "s1", kind: "tcp", target: "127.0.0.1:5432", ...extra });

  it("warns that a loopback-only port is refused over via: tailscale", async () => {
    const [w, ...rest] = await tailnetWarnings(scan("127.0.0.1"), body({ via: "tailscale" }));
    expect(w).toContain("listens only on 127.0.0.1");
    expect(w).toContain("connections will be refused");
    expect(rest).toEqual([]);
  });

  it("says via: auto will use the relay instead", async () => {
    expect((await tailnetWarnings(scan("127.0.0.1"), body({ via: "auto" })))[0]).toContain("will use the relay");
  });

  it("warns about a target only the server can resolve", async () => {
    expect((await tailnetWarnings(scan("0.0.0.0"), body({ via: "tailscale", target: "db.internal:5432" })))[0]).toContain("not loopback");
  });

  it("stays quiet for a reachable port, the relay, a reverse tunnel, a missing port and a failed scan", async () => {
    expect(await tailnetWarnings(scan("0.0.0.0"), body({ via: "tailscale" }))).toEqual([]);
    expect(await tailnetWarnings(scan("127.0.0.1"), body({ via: "reoclo" }))).toEqual([]);
    expect(await tailnetWarnings(scan("127.0.0.1"), body({}))).toEqual([]);
    expect(await tailnetWarnings(scan("127.0.0.1"), { org: "acme", server_id: "s1", kind: "reverse", via: "tailscale" })).toEqual([]);
    expect(await tailnetWarnings(scan("127.0.0.1"), body({ via: "tailscale", target: "127.0.0.1:9999" }))).toEqual([]);
    expect(await tailnetWarnings({ ports: () => Promise.reject(new Error("no scan")) }, body({ via: "tailscale" }))).toEqual([]);
    expect(await tailnetWarnings({ ports: () => Promise.resolve([]) }, body({ via: "tailscale" }))).toEqual([]);
  });
});

describe("path and share in the tunnel list", () => {
  const view = (extra: Partial<TunnelView>): TunnelView => ({
    name: "db",
    org: "acme",
    server: "prod-1",
    server_id: "s1",
    kind: "tcp",
    keep_up: false,
    enabled: true,
    via: "auto",
    path: "tailscale",
    state: "active",
    message: "",
    action: "None",
    endpoint: "127.0.0.1:15432",
    target: "127.0.0.1:5432",
    traffic: { bytes_in: 0, bytes_out: 0, streams: 0 },
    ...extra,
  });

  it("shows where a share answers once it is up, and its state before that", () => {
    expect(sharedLabel(view({}))).toBe("");
    expect(sharedLabel(view({ share: { tailnet: true, port: 5432, state: "active", url: "tcp://box.ts.net:5432", restarts: 0 } }))).toBe("tcp://box.ts.net:5432");
    expect(sharedLabel(view({ share: { tailnet: true, port: 5432, state: "starting", restarts: 0 } }))).toBe("starting");
    expect(sharedLabel(view({ share: { tailnet: true, port: 5432, state: "failed", error: "x", restarts: 0 } }))).toBe("failed");
  });

  it("adds the path reason and the share's error to the detail", () => {
    const detail = detailFor(view({ path: "relay", path_reason: "prod-1 is offline on the tailnet", share: { tailnet: true, port: 1, state: "failed", error: "Tailscale is not running", restarts: 0 } }));
    expect(detail).toBe("prod-1 is offline on the tailnet; share: Tailscale is not running");
  });

  it("prints PATH and SHARED columns, and the whole view as JSON", () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    };
    try {
      formatSavedTunnels([view({ share: { tailnet: true, port: 5432, state: "active", url: "tcp://box.ts.net:5432", restarts: 0 } })], "text");
      formatSavedTunnels([view({})], "json");
    } finally {
      process.stdout.write = write;
    }
    const text = out.join("");
    expect(text).toMatch(/PATH\s+SHARED/);
    expect(text).toMatch(/tailscale\s+tcp:\/\/box.ts.net:5432/);
    expect(JSON.parse(out.at(-1) ?? "{}")).toMatchObject({ via: "auto", path: "tailscale" });
  });

  it("registers the share, unshare, --via and --tailnet-host options", () => {
    const program = new Command().exitOverride();
    registerTunnel(program);
    const tunnel = program.commands.find((c) => c.name() === "tunnel")!;
    const sub = (n: string) => tunnel.commands.find((c) => c.name() === n)!;
    expect(sub("share").options.map((o) => o.long)).toEqual(["--tailnet", "--port"]);
    expect(sub("unshare").registeredArguments.map((a) => a.name())).toEqual(["name"]);
    for (const n of ["add", "edit"]) {
      for (const flag of ["--via", "--tailnet-host"]) expect(sub(n).options.map((o) => o.long)).toContain(flag);
    }
  });
});
