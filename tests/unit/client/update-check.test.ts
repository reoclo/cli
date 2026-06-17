import { describe, expect, test } from "bun:test";
import {
  formatUpdateNotice,
  isCheckStale,
  isNewer,
  reinvokeForUpdateCheck,
  runUpdateCheckCycle,
  shouldNotify,
  shouldRunUpdateCheck,
  type UpdateCache,
} from "../../../src/client/update-check";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("isNewer", () => {
  test("a higher minor is newer", () => {
    expect(isNewer("0.48.0", "0.49.0")).toBe(true);
  });
  test("the same version is not newer", () => {
    expect(isNewer("0.49.0", "0.49.0")).toBe(false);
  });
  test("a lower version is not newer", () => {
    expect(isNewer("0.49.0", "0.48.0")).toBe(false);
  });
  test("tolerates a leading v on either side", () => {
    expect(isNewer("v0.48.0", "0.49.0")).toBe(true);
    expect(isNewer("0.48.0", "v0.49.0")).toBe(true);
  });
  test("compares patch", () => {
    expect(isNewer("0.48.1", "0.48.2")).toBe(true);
    expect(isNewer("0.48.2", "0.48.1")).toBe(false);
  });
  test("compares major ahead of minor", () => {
    expect(isNewer("0.99.0", "1.0.0")).toBe(true);
    expect(isNewer("1.0.0", "0.99.9")).toBe(false);
  });
});

describe("isCheckStale", () => {
  test("never-checked (undefined) is stale", () => {
    expect(isCheckStale(undefined, 1_000_000, DAY)).toBe(true);
  });
  test("older than the TTL is stale", () => {
    const checkedAt = new Date(1_000_000).toISOString();
    expect(isCheckStale(checkedAt, 1_000_000 + DAY + 1, DAY)).toBe(true);
  });
  test("within the TTL is fresh", () => {
    const checkedAt = new Date(1_000_000).toISOString();
    expect(isCheckStale(checkedAt, 1_000_000 + HOUR, DAY)).toBe(false);
  });
  test("an unparseable timestamp is treated as stale", () => {
    expect(isCheckStale("not-a-date", 1_000_000, DAY)).toBe(true);
  });
});

describe("shouldNotify", () => {
  const base = { current: "0.48.0", latest: "0.49.0", now: 10 * DAY, throttleMs: DAY };

  test("notifies for a newer version never notified before", () => {
    expect(shouldNotify({ ...base, notifiedAt: undefined })).toBe(true);
  });
  test("does not notify within the throttle window", () => {
    const notifiedAt = new Date(10 * DAY - HOUR).toISOString();
    expect(shouldNotify({ ...base, notifiedAt })).toBe(false);
  });
  test("notifies again after the throttle window", () => {
    const notifiedAt = new Date(10 * DAY - DAY - 1).toISOString();
    expect(shouldNotify({ ...base, notifiedAt })).toBe(true);
  });
  test("never notifies when latest is not newer", () => {
    expect(shouldNotify({ ...base, latest: "0.48.0", notifiedAt: undefined })).toBe(false);
  });
  test("never notifies when latest is unknown", () => {
    expect(shouldNotify({ ...base, latest: undefined, notifiedAt: undefined })).toBe(false);
  });
});

describe("shouldRunUpdateCheck", () => {
  const ok = {
    disabledByEnv: false,
    disabledByFlag: false,
    isTTY: true,
    outputFormat: "text",
    automationKey: false,
    quiet: false,
  };

  test("runs under interactive, text, non-CI defaults", () => {
    expect(shouldRunUpdateCheck(ok)).toBe(true);
  });
  test("suppressed by REOCLO_NO_UPDATE_CHECK", () => {
    expect(shouldRunUpdateCheck({ ...ok, disabledByEnv: true })).toBe(false);
  });
  test("suppressed by --no-update-check", () => {
    expect(shouldRunUpdateCheck({ ...ok, disabledByFlag: true })).toBe(false);
  });
  test("suppressed when stderr is not a TTY (pipes / CI)", () => {
    expect(shouldRunUpdateCheck({ ...ok, isTTY: false })).toBe(false);
  });
  test("suppressed for machine output formats", () => {
    expect(shouldRunUpdateCheck({ ...ok, outputFormat: "json" })).toBe(false);
    expect(shouldRunUpdateCheck({ ...ok, outputFormat: "yaml" })).toBe(false);
  });
  test("suppressed under an automation key", () => {
    expect(shouldRunUpdateCheck({ ...ok, automationKey: true })).toBe(false);
  });
  test("suppressed under --quiet", () => {
    expect(shouldRunUpdateCheck({ ...ok, quiet: true })).toBe(false);
  });
});

describe("formatUpdateNotice", () => {
  test("names both versions and the install-specific command", () => {
    expect(formatUpdateNotice("0.48.0", "0.49.0", "homebrew")).toBe(
      "⚡ reoclo 0.49.0 available (you have 0.48.0) — brew upgrade reoclo/tap/reoclo",
    );
  });
  test("uses the package-manager command for managed installs", () => {
    expect(formatUpdateNotice("0.48.0", "0.49.0", "npm")).toBe(
      "⚡ reoclo 0.49.0 available (you have 0.48.0) — npm i -g @reoclo/cli@0.49.0",
    );
  });
});

describe("reinvokeForUpdateCheck", () => {
  test("compiled-binary form: re-spawns the binary via execPath with the sentinel", () => {
    expect(
      reinvokeForUpdateCheck(["bun", "/usr/local/bin/reoclo", "apps", "ls"], "/usr/local/bin/reoclo"),
    ).toEqual(["/usr/local/bin/reoclo", ["__update-check"]]);
  });
  test("compiled-binary form: never re-spawns 'bun' from argv[0]", () => {
    const [exe] = reinvokeForUpdateCheck(["bun", "/usr/local/bin/reoclo", "whoami"], "/usr/local/bin/reoclo");
    expect(exe).not.toBe("bun");
  });
  test("runtime form: keeps the script path when the runtime is bun", () => {
    expect(
      reinvokeForUpdateCheck(["/usr/bin/bun", "/repo/src/index.ts", "apps", "ls"], "/usr/bin/bun"),
    ).toEqual(["/usr/bin/bun", ["/repo/src/index.ts", "__update-check"]]);
  });
});

describe("runUpdateCheckCycle", () => {
  const FRESH = new Date(10 * DAY - HOUR).toISOString();
  function harness(cache: UpdateCache) {
    const emitted: string[] = [];
    const written: UpdateCache[] = [];
    const state = { spawned: 0 };
    const deps = {
      current: "0.48.0",
      now: 10 * DAY,
      ttlMs: DAY,
      throttleMs: DAY,
      readCache: () => cache,
      writeCache: (c: UpdateCache) => written.push(c),
      detectMethod: () => "homebrew" as const,
      emit: (l: string) => emitted.push(l),
      spawnCheck: () => {
        state.spawned += 1;
      },
    };
    return { deps, emitted, written, state };
  }

  test("emits a notice and records notified_at for a newer cached version", () => {
    const h = harness({ latest: "0.49.0", checked_at: FRESH });
    runUpdateCheckCycle(h.deps);
    expect(h.emitted).toEqual([formatUpdateNotice("0.48.0", "0.49.0", "homebrew")]);
    expect(h.written).toHaveLength(1);
    expect(typeof h.written[0]?.notified_at).toBe("string");
  });

  test("does not emit when the cached latest is not newer", () => {
    const h = harness({ latest: "0.48.0", checked_at: FRESH });
    runUpdateCheckCycle(h.deps);
    expect(h.emitted).toEqual([]);
    expect(h.written).toEqual([]);
  });

  test("schedules a background check when the cache is stale", () => {
    const h = harness({}); // no checked_at → stale
    runUpdateCheckCycle(h.deps);
    expect(h.state.spawned).toBe(1);
  });

  test("does not schedule a background check when the cache is fresh", () => {
    const h = harness({ checked_at: FRESH });
    runUpdateCheckCycle(h.deps);
    expect(h.state.spawned).toBe(0);
  });

  test("does not re-notify within the throttle window", () => {
    const h = harness({
      latest: "0.49.0",
      checked_at: FRESH,
      notified_at: new Date(10 * DAY - HOUR).toISOString(),
    });
    runUpdateCheckCycle(h.deps);
    expect(h.emitted).toEqual([]);
  });
});
