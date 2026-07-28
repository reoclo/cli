import { describe, expect, test } from "bun:test";
import {
  POWER_ENDPOINT,
  powerNeedsConfirm,
  targetStateFor,
  powerErrorHint,
  pollUntilState,
} from "../../../src/commands/servers-power";

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
      statusFn: async () => states[i++] ?? null,
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
      statusFn: async () => {
        calls++;
        return "running";
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
