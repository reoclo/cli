import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { applyVerbAliases } from "../../../src/lib/verb-aliases";
import { registerTunnel } from "../../../src/commands/tunnel";
import {
  buildAddBody,
  buildEditBody,
  detailFor,
  parseHostPortFlag,
  parsePortFlag,
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
    expect(() => buildAddBody("a", { kind: "https", target: "80" }, ctx)).toThrow(/expected tcp, udp or reverse/);
  });
  it("marks usage errors with exit code 2", () => {
    try {
      buildAddBody("a", {}, ctx);
    } catch (e) {
      expect((e as UsageError).exitCode).toBe(2);
    }
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
  });
});

describe("command registration", () => {
  const program = new Command().exitOverride();
  registerTunnel(program);
  applyVerbAliases(program);
  const tunnel = program.commands.find((c) => c.name() === "tunnel")!;
  const names = (c: Command): string[] => c.commands.map((x) => x.name());

  it("keeps ls, describe and close and adds the saved-tunnel verbs", () => {
    for (const n of ["ls", "describe", "close", "status", "add", "edit", "rm", "up", "down", "daemon"]) {
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
