import { messageOf, rejectionOf } from "../../helpers/rejection";
import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import net from "node:net";
import {
  assertPort443Free,
  buildSetupCommand,
  buildUninstallCommand,
  formatListing,
  helperLine,
  isCompiledBinary,
  registerHosts,
} from "../../../src/commands/hosts";
import { mergeSuffixes } from "../../../src/commands/tunnel-trust";
import { UsageError } from "../../../src/commands/tunnel-saved";
import { applyVerbAliases } from "../../../src/lib/verb-aliases";
import type { HostsStatusView } from "../../../src/tunnels/manager";
import { freePort } from "../../helpers/fake-ws-gateway";

const helper = (o: Partial<HostsStatusView> = {}): HostsStatusView => ({
  installed: true,
  entries: 2,
  suffixes: [],
  relay: { enabled: false, listening: false },
  ...o,
});

describe("hosts command registration", () => {
  const program = new Command().exitOverride();
  registerHosts(program);
  applyVerbAliases(program);
  const hosts = program.commands.find((c) => c.name() === "hosts")!;

  it("registers ls, add, rm, sync, setup and uninstall", () => {
    expect(hosts.commands.map((c) => c.name())).toEqual(["ls", "add", "rm", "sync", "setup", "uninstall"]);
  });

  it("gets list and remove from the verb-alias layer, not by hand", () => {
    const ls = hosts.commands.find((c) => c.name() === "ls")!;
    const rm = hosts.commands.find((c) => c.name() === "rm")!;
    expect(ls.aliases()).toEqual(["list"]);
    expect(rm.aliases().sort()).toEqual(["delete", "remove"]);
  });

  it("takes repeatable --allow-suffix and --port-443 on setup", () => {
    const setup = hosts.commands.find((c) => c.name() === "setup")!;
    expect(setup.options.map((o) => o.long)).toEqual(["--allow-suffix", "--port-443"]);
  });
});

describe("setup command line", () => {
  const input = { execPath: "/usr/local/bin/reoclo", script: undefined, uid: 501, allowSuffixes: [], port443: false, relayPort: 8443, root: false };

  it("runs the CLI under sudo as __hostsd-install with the installing uid", () => {
    expect(buildSetupCommand(input)).toEqual({ cmd: "sudo", args: ["/usr/local/bin/reoclo", "__hostsd-install", "--uid", "501"] });
  });

  it("passes each allowed suffix and the relay port", () => {
    const { args } = buildSetupCommand({ ...input, allowSuffixes: ["internal", "corp.example.com"], port443: true, relayPort: 9443 });
    expect(args).toEqual([
      "/usr/local/bin/reoclo",
      "__hostsd-install",
      "--uid",
      "501",
      "--allow-suffix",
      "internal",
      "--allow-suffix",
      "corp.example.com",
      "--port-443",
      "--relay-port",
      "9443",
    ]);
  });

  it("does not pass a relay port without --port-443", () => {
    expect(buildSetupCommand({ ...input, relayPort: 9443 }).args).not.toContain("--relay-port");
  });

  it("skips sudo when already root", () => {
    expect(buildSetupCommand({ ...input, root: true }).cmd).toBe("/usr/local/bin/reoclo");
    expect(buildUninstallCommand("/usr/local/bin/reoclo", false)).toEqual({ cmd: "sudo", args: ["/usr/local/bin/reoclo", "__hostsd-uninstall"] });
    expect(buildUninstallCommand("/usr/local/bin/reoclo", true).cmd).toBe("/usr/local/bin/reoclo");
  });

  it("only accepts a compiled binary", () => {
    expect(isCompiledBinary("/$bunfs/root/reoclo")).toBe(true);
    expect(isCompiledBinary(undefined)).toBe(true);
    expect(isCompiledBinary("/repo/src/index.ts")).toBe(false);
  });
});

describe("--port-443", () => {
  it("refuses when something answers on 443 and says why", async () => {
    expect(messageOf(await rejectionOf(assertPort443Free(() => Promise.resolve(true))))).toMatch(/already answers on port 443/);
    expect(await rejectionOf(assertPort443Free(() => Promise.resolve(true)))).toBeInstanceOf(UsageError);
    expect(messageOf(await rejectionOf(assertPort443Free((_p, host) => Promise.resolve(host === "::1"))))).toMatch(/Caddy/);
  });

  it("passes when nothing answers", async () => {
    expect(await assertPort443Free(() => Promise.resolve(false))).toBeUndefined();
  });

  it("probes the port it is asked about", async () => {
    const seen: number[] = [];
    await assertPort443Free((p) => (seen.push(p), Promise.resolve(false)));
    expect(new Set(seen)).toEqual(new Set([443]));
    const server = net.createServer();
    const port = await freePort();
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    const { answers } = await import("../../../src/hostsd/main");
    expect(await answers(port, "127.0.0.1")).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await answers(port, "127.0.0.1")).toBe(false);
  });
});

describe("helperLine", () => {
  it("describes each helper state", () => {
    expect(helperLine(helper({ installed: false }))).toMatch(/not installed.*reoclo hosts setup/);
    expect(helperLine(helper({ error: "boom" }))).toBe("helper: error: boom");
    expect(helperLine(helper())).toBe("helper: installed, 2 entries in /etc/hosts, port 443 relay off");
    expect(helperLine(helper({ relay: { enabled: true, listening: true, port: 8443 } }))).toContain("port 443 relays to 8443");
    expect(helperLine(helper({ relay: { enabled: true, listening: false, error: "busy" } }))).toContain("relay is off (busy)");
  });

  it("prints json lines for ls", () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string) => (out.push(s), true);
    try {
      formatListing({ entries: [{ hostname: "a.reoclo.localhost", source: "grafana" }], helper: helper() }, "json");
    } finally {
      process.stdout.write = write;
    }
    expect(out.join("")).toBe(`${JSON.stringify({ hostname: "a.reoclo.localhost", source: "grafana" })}\n`);
  });
});

describe("tunnel trust suffixes", () => {
  it("merges requested suffixes into the existing ones, sorted and unique", () => {
    expect(mergeSuffixes(["internal"], ["corp.example.com", "internal"])).toEqual(["corp.example.com", "internal"]);
    expect(mergeSuffixes([], [])).toEqual([]);
  });

  it("turns a dangerous suffix into a usage error", () => {
    expect(() => mergeSuffixes([], ["com"])).toThrow(UsageError);
  });
});
