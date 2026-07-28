import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import {
  POWER_ENDPOINT,
  powerNeedsConfirm,
  targetStateFor,
  powerErrorHint,
  pollUntilState,
} from "../../../src/commands/servers-power";
import { registerServers } from "../../../src/commands/servers";

function powerGroup(): Command {
  const p = new Command().name("reoclo");
  registerServers(p);
  const servers = p.commands.find((c) => c.name() === "servers")!;
  return servers.commands.find((c) => c.name() === "power")!;
}

describe("cloud-power helpers", () => {
  test("POWER_ENDPOINT maps every action to its cloud path suffix", () => {
    expect(POWER_ENDPOINT.on).toBe("power-on");
    expect(POWER_ENDPOINT.off).toBe("power-off");
    expect(POWER_ENDPOINT.shutdown).toBe("shutdown");
    expect(POWER_ENDPOINT.reboot).toBe("reboot");
    expect(POWER_ENDPOINT.reset).toBe("reset");
  });

  test("interrupting actions require confirmation; on does not", () => {
    expect(powerNeedsConfirm("off")).toBe(true);
    expect(powerNeedsConfirm("shutdown")).toBe(true);
    expect(powerNeedsConfirm("reboot")).toBe(true);
    expect(powerNeedsConfirm("reset")).toBe(true);
    expect(powerNeedsConfirm("on")).toBe(false);
  });

  test("targetStateFor resolves the expected end state", () => {
    expect(targetStateFor("on")).toBe("running");
    expect(targetStateFor("reboot")).toBe("running");
    expect(targetStateFor("reset")).toBe("running");
    expect(targetStateFor("off")).toBe("stopped");
    expect(targetStateFor("shutdown")).toBe("stopped");
  });

  test("powerErrorHint gives actionable hints for 400/409/422 only", () => {
    expect(powerErrorHint(422)).toContain("capabilities");
    expect(powerErrorHint(400)).toContain("cloud");
    expect(powerErrorHint(409)).toContain("in progress");
    expect(powerErrorHint(404)).toBeNull();
    expect(powerErrorHint(502)).toBeNull();
  });

  test("pollUntilState reaches the target once observed", async () => {
    const states = ["stopping", "stopping", "stopped"];
    let i = 0;
    const r = await pollUntilState({
      statusFn: () => Promise.resolve(states[i++] ?? null),
      target: "stopped",
      attempts: 5,
      sleepMs: 0,
      sleep: async () => {},
    });
    expect(r.reached).toBe(true);
    expect(r.lastState).toBe("stopped");
  });

  test("pollUntilState times out after the attempt budget", async () => {
    let calls = 0;
    const r = await pollUntilState({
      statusFn: () => {
        calls++;
        return Promise.resolve("running");
      },
      target: "stopped",
      attempts: 3,
      sleepMs: 0,
      sleep: async () => {},
    });
    expect(r.reached).toBe(false);
    expect(r.lastState).toBe("running");
    expect(calls).toBe(3);
  });
});

describe("reoclo servers power (actions)", () => {
  test("power group is registered under servers and mentions the cloud provider", () => {
    const g = powerGroup();
    expect(g).toBeDefined();
    expect(g.description().toLowerCase()).toContain("cloud");
  });

  test("all five action subcommands are registered", () => {
    const names = powerGroup().commands.map((c) => c.name());
    for (const n of ["on", "off", "shutdown", "reboot", "reset"]) {
      expect(names).toContain(n);
    }
  });

  test("off carries --yes, --wait and --wait-timeout", () => {
    const off = powerGroup().commands.find((c) => c.name() === "off")!;
    const longs = off.options.map((o) => o.long);
    expect(longs).toContain("--yes");
    expect(longs).toContain("--wait");
    expect(longs).toContain("--wait-timeout");
  });

  test("on has --wait but no --yes (no confirmation on power-on)", () => {
    const on = powerGroup().commands.find((c) => c.name() === "on")!;
    const longs = on.options.map((o) => o.long);
    expect(longs).toContain("--wait");
    expect(longs).not.toContain("--yes");
  });

  test("power reboot help distinguishes it from the runner reboot", () => {
    const reboot = powerGroup().commands.find((c) => c.name() === "reboot")!;
    expect(reboot.description().toLowerCase()).toContain("cloud");
  });

  test("the runner-based servers reboot still exists (regression)", () => {
    const p = new Command().name("reoclo");
    registerServers(p);
    const servers = p.commands.find((c) => c.name() === "servers")!;
    expect(servers.commands.map((c) => c.name())).toContain("reboot");
  });
});

describe("reoclo servers power (reads)", () => {
  test("status and capabilities subcommands are registered", () => {
    const names = powerGroup().commands.map((c) => c.name());
    expect(names).toContain("status");
    expect(names).toContain("capabilities");
  });

  test("status takes an idOrSlug and does not confirm", () => {
    const status = powerGroup().commands.find((c) => c.name() === "status")!;
    expect(status.usage()).toContain("idOrSlug");
    expect(status.options.map((o) => o.long)).not.toContain("--yes");
  });

  test("capabilities describes what the provider supports", () => {
    const caps = powerGroup().commands.find((c) => c.name() === "capabilities")!;
    expect(caps.description().toLowerCase()).toContain("support");
  });
});
