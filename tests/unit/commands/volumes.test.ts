import { describe, expect, test } from "bun:test";
import { Command, type Option } from "commander";
import {
  registerVolumes,
  formatBytes,
  assertListing,
  type VolumesListResponse,
} from "../../../src/commands/volumes";
import { getRequiredCapability } from "../../../src/client/command-meta";

function volumesCmd(): Command {
  const p = new Command().name("reoclo");
  registerVolumes(p);
  return p.commands.find((c) => c.name() === "volumes")!;
}

function optNames(cmd: Command): string[] {
  return cmd.options.map((o) => o.long ?? o.short ?? "");
}

describe("reoclo volumes (registration)", () => {
  test("registers ls/inspect/create/rm/prune", () => {
    const names = volumesCmd().commands.map((c) => c.name());
    expect(names).toContain("ls");
    expect(names).toContain("inspect");
    expect(names).toContain("create");
    expect(names).toContain("rm");
    expect(names).toContain("prune");
  });

  test("ls and inspect carry volume:read", () => {
    const g = volumesCmd();
    expect(getRequiredCapability(g.commands.find((c) => c.name() === "ls")!)).toBe("volume:read");
    expect(getRequiredCapability(g.commands.find((c) => c.name() === "inspect")!)).toBe(
      "volume:read",
    );
  });

  test("create/rm/prune carry volume:write", () => {
    const g = volumesCmd();
    for (const n of ["create", "rm", "prune"]) {
      const c = g.commands.find((x) => x.name() === n)!;
      expect(c, `${n} registered`).toBeDefined();
      expect(getRequiredCapability(c)).toBe("volume:write");
    }
  });

  test("create exposes --driver and --label", () => {
    const g = volumesCmd();
    const create = g.commands.find((c) => c.name() === "create")!;
    const names = optNames(create);
    expect(names).toContain("--driver");
    expect(names).toContain("--label");
  });

  test("rm and prune expose --yes", () => {
    const g = volumesCmd();
    expect(optNames(g.commands.find((c) => c.name() === "rm")!)).toContain("--yes");
    expect(optNames(g.commands.find((c) => c.name() === "prune")!)).toContain("--yes");
  });
});

describe("create --label collection", () => {
  // collectKV is module-private in volumes.ts (mirroring containers.ts). Drive
  // it through the actual registered Option the way commander itself would:
  // repeated --label flags accumulate into one KEY=VALUE dict.
  function labelOption(): Option {
    const g = volumesCmd();
    const create = g.commands.find((c) => c.name() === "create")!;
    const opt = create.options.find((o) => o.long === "--label");
    if (!opt) throw new Error("--label option not registered");
    return opt;
  }

  test("a single --label KEY=VALUE parses to a one-entry dict", () => {
    const opt = labelOption();
    const result = opt.parseArg!("team=platform", {});
    expect(result).toEqual({ team: "platform" });
  });

  test("repeated --label flags accumulate", () => {
    const opt = labelOption();
    let acc = {};
    acc = opt.parseArg!("team=platform", acc);
    acc = opt.parseArg!("tier=prod", acc);
    expect(acc).toEqual({ team: "platform", tier: "prod" });
  });

  test("a later --label with the same key overwrites the earlier one", () => {
    const opt = labelOption();
    let acc = {};
    acc = opt.parseArg!("team=platform", acc);
    acc = opt.parseArg!("team=infra", acc);
    expect(acc).toEqual({ team: "infra" });
  });

  test("a value missing '=' throws", () => {
    const opt = labelOption();
    expect(() => opt.parseArg!("no-equals-sign", {})).toThrow();
  });

  test("does not mutate the previous accumulator (each call returns a new object)", () => {
    const opt = labelOption();
    const first = opt.parseArg!("a=1", {});
    const second = opt.parseArg!("b=2", first);
    expect(first).toEqual({ a: "1" });
    expect(second).toEqual({ a: "1", b: "2" });
  });
});

describe("formatBytes", () => {
  test("null renders as '-'", () => {
    expect(formatBytes(null)).toBe("-");
  });

  test("sub-KB values render in bytes", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(1023)).toBe("1023B");
  });

  test("KB range", () => {
    expect(formatBytes(1024)).toBe("1.0KB");
    expect(formatBytes(1024 * 10)).toBe("10.0KB");
  });

  test("MB range", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0MB");
    expect(formatBytes(1024 * 1024 * 120)).toBe("120.0MB");
  });

  test("GB range", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0GB");
    expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe("2.5GB");
  });
});

describe("assertListing", () => {
  const VOLS = [
    {
      name: "pgdata",
      driver: "local",
      mountpoint: "/var/lib/docker/volumes/pgdata/_data",
      created_at: "2026-08-01T10:00:00+01:00",
      labels: {},
      in_use: true,
      used_by: ["db-1"],
      size_bytes: 120_000_000,
      protected: false,
    },
  ];

  test("returns the volumes when partial_error is null", () => {
    const res: VolumesListResponse = { volumes: VOLS, partial_error: null };
    expect(assertListing(res)).toBe(VOLS);
  });

  test("throws when partial_error is non-null, never returning an empty list silently", () => {
    const res: VolumesListResponse = { volumes: [], partial_error: "runner timed out" };
    expect(() => assertListing(res)).toThrow("runner timed out");
  });

  test("throws even when volumes is non-empty alongside a partial_error", () => {
    const res: VolumesListResponse = { volumes: VOLS, partial_error: "listing degraded" };
    expect(() => assertListing(res)).toThrow("listing degraded");
  });
});
