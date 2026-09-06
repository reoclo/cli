import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerDomains, planRows, pollPublish } from "../../../src/commands/domains";
import { getCompletionSpec } from "../../../src/client/command-meta";

describe("domains dns/health/rm", () => {
  test("all three subcommands registered with withCompletion(domains)", () => {
    const program = new Command().name("reoclo");
    registerDomains(program);
    const domains = program.commands.find((c) => c.name() === "domains")!;
    const names = domains.commands.map((c) => c.name());
    for (const n of ["dns", "health", "rm"]) {
      expect(names).toContain(n);
    }
    for (const n of ["dns", "health", "rm"]) {
      const cmd = domains.commands.find((c) => c.name() === n)!;
      const spec = getCompletionSpec(cmd);
      expect(spec).toBeDefined();
      expect(spec!.args).toEqual([{ slot: 0, resource: "domains" }]);
    }
  });

  test("rm has --yes flag", () => {
    const program = new Command().name("reoclo");
    registerDomains(program);
    const rm = program.commands
      .find((c) => c.name() === "domains")!
      .commands.find((c) => c.name() === "rm")!;
    const longs = rm.options.map((o) => o.long);
    expect(longs).toContain("--yes");
  });
});

describe("domains dns --fix", () => {
  test("dns has --fix, --proxied and --yes flags", () => {
    const program = new Command().name("reoclo");
    registerDomains(program);
    const dns = program.commands.find((c) => c.name() === "domains")!.commands.find((c) => c.name() === "dns")!;
    const longs = dns.options.map((o) => o.long);
    for (const flag of ["--fix", "--proxied", "--yes"]) expect(longs).toContain(flag);
  });

  test("planRows flattens ops for the text table and drops keep rows", () => {
    const rows = planRows({
      credential_label: "cf", zone_name: "example.com", server_name: "core", plan_hash: "h", blocked_reason: null,
      ops: [
        { op: "update", record_type: "A", name: "a.example.com", current_content: "1.1.1.1", current_proxied: false, desired_content: "2.2.2.2", desired_proxied: false, reason: null },
        { op: "keep", record_type: "TXT", name: "t", current_content: "x", current_proxied: false, desired_content: "x", desired_proxied: false, reason: null },
        { op: "delete", record_type: "A", name: "a.example.com", current_content: "3.3.3.3", current_proxied: false, desired_content: null, desired_proxied: null, reason: null },
      ],
    });
    expect(rows).toEqual([
      { action: "update", type: "A", name: "a.example.com", current: "1.1.1.1", new: "2.2.2.2" },
      { action: "delete", type: "A", name: "a.example.com", current: "3.3.3.3", new: "-" },
    ]);
  });

  test("pollPublish returns once the publish leaves pending", async () => {
    const states = ["pending", "pending", "succeeded"];
    let i = 0;
    const fetch = () => Promise.resolve({ dns: { publish: { status: states[i++]!, applied: ["A x -> y (created)"], last_error: null } } });
    const out = await pollPublish(fetch, { attempts: 5, sleepMs: 0, sleep: async () => {} });
    expect(out?.status).toBe("succeeded");
    expect(i).toBe(3);
  });

  test("pollPublish gives up after attempts", async () => {
    const fetch = () => Promise.resolve({ dns: { publish: { status: "pending", applied: [], last_error: null } } });
    expect(await pollPublish(fetch, { attempts: 2, sleepMs: 0, sleep: async () => {} })).toBeNull();
  });
});
