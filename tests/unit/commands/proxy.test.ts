import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { allowlistPutBody, registerProxy } from "../../../src/commands/proxy";
import { getCompletionSpec } from "../../../src/client/command-meta";

function exitCodeOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { exitCode?: number }).exitCode;
  }
  return undefined;
}

function allowlistCommand(): Command {
  const program = new Command().name("reoclo");
  registerProxy(program);
  return program.commands.find((c) => c.name() === "proxy")!.commands.find((c) => c.name() === "allowlist")!;
}

describe("proxy allowlist", () => {
  test("is registered with completion on the server argument and has the flags", () => {
    const cmd = allowlistCommand();
    expect(getCompletionSpec(cmd)!.args).toEqual([{ slot: 0, resource: "servers" }]);
    const longs = cmd.options.map((o) => o.long);
    for (const flag of ["--allow", "--cloudflare", "--no-cloudflare", "--clear"]) expect(longs).toContain(flag);
  });

  test("repeated --allow collects, and cloudflare stays unset when no flag is given", () => {
    const cmd = allowlistCommand();
    cmd.parseOptions(["--allow", "10.0.0.0/8", "--allow", "1.2.3.4"]);
    expect(cmd.opts()).toMatchObject({ allow: ["10.0.0.0/8", "1.2.3.4"] });
    expect(cmd.opts()["cloudflare"]).toBeUndefined();
  });

  test("no flags means show, not write", () => {
    expect(allowlistPutBody({}, { cidrs: [], presets: ["cloudflare"] })).toBeNull();
  });

  test("--clear sends null", () => {
    expect(allowlistPutBody({ clear: true }, { cidrs: ["10.0.0.0/8"], presets: [] })).toEqual({ ip_allowlist: null });
  });

  test("--allow and --cloudflare merge into the current default", () => {
    const current = { cidrs: ["10.0.0.0/8"], presets: [] as Array<"cloudflare"> };
    expect(allowlistPutBody({ cloudflare: true }, current)).toEqual({
      ip_allowlist: { cidrs: ["10.0.0.0/8"], presets: ["cloudflare"] },
    });
    expect(allowlistPutBody({ allow: ["192.0.2.0/24"] }, { cidrs: ["10.0.0.0/8"], presets: ["cloudflare"] })).toEqual({
      ip_allowlist: { cidrs: ["192.0.2.0/24"], presets: ["cloudflare"] },
    });
    expect(allowlistPutBody({ allow: ["192.0.2.0/24"] }, null)).toEqual({
      ip_allowlist: { cidrs: ["192.0.2.0/24"], presets: [] },
    });
  });

  test("--clear with --allow or --cloudflare exits 2", () => {
    expect(exitCodeOf(() => allowlistPutBody({ clear: true, allow: ["10.0.0.0/8"] }, null))).toBe(2);
    expect(exitCodeOf(() => allowlistPutBody({ clear: true, cloudflare: false }, null))).toBe(2);
  });

  test("a merge that leaves nothing exits 2 instead of opening access", () => {
    expect(exitCodeOf(() => allowlistPutBody({ cloudflare: false }, { cidrs: [], presets: ["cloudflare"] }))).toBe(2);
    expect(exitCodeOf(() => allowlistPutBody({ cloudflare: false }, null))).toBe(2);
  });
});
