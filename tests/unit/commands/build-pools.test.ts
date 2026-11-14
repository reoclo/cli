import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerBuildPools } from "../../../src/commands/build-pools";
import { getCompletionSpec } from "../../../src/client/command-meta";
import { NotFoundError, ApiError } from "../../../src/client/errors";
import { awakeSession, budgetNote, builderWarning, COST_DATA_UNAVAILABLE, costRoute } from "../../../src/commands/build-pools-costs";
import { ephemeralFields, formatHourly, parseIdlePolicy, parseMoney } from "../../../src/util/ephemeral-pool";

function pools(): Command {
  const program = new Command().name("reoclo");
  registerBuildPools(program);
  return program.commands.find((c) => c.name() === "build-pools")!;
}

function sub(name: string): Command {
  return pools().commands.find((c) => c.name() === name)!;
}

describe("reoclo build-pools", () => {
  test("registers pool management and ephemeral cost commands", () => {
    expect(pools().commands.map((c) => c.name()).sort()).toEqual(
      ["builders", "costs", "create", "estimate", "get", "ls", "reconcile", "rm", "set"],
    );
  });

  test("create and set take the ephemeral pool flags", () => {
    const flags = ["--cloud-credential", "--location", "--server-type", "--fallback-type", "--arch", "--snapshot", "--max-servers", "--idle-policy", "--max-lifetime", "--max-builder-age-days", "--cache", "--budget", "--budget-currency"];
    for (const name of ["create", "set"]) {
      const longs = sub(name).options.map((o) => o.long);
      for (const flag of flags) expect(longs).toContain(flag);
    }
    expect(sub("create").options.map((o) => o.long)).toContain("--mode");
  });

  test("budgets parse to exact cents and refuse sub-cent or grouped amounts", () => {
    expect(parseMoney("25.50", "--budget")).toBe(2550);
    expect(parseMoney("0.29", "--budget")).toBe(29);
    expect(parseMoney("25", "--budget")).toBe(2500);
    expect(() => parseMoney("25.555", "--budget")).toThrow();
    expect(() => parseMoney("1,000", "--budget")).toThrow();
  });

  test("idle policies accept hour_aware, immediate and bounded ttl minutes", () => {
    expect(parseIdlePolicy("hour_aware")).toBe("hour_aware");
    expect(parseIdlePolicy("ttl:15")).toBe("ttl:15");
    expect(() => parseIdlePolicy("ttl:0")).toThrow();
    expect(() => parseIdlePolicy("later")).toThrow();
  });

  test("hourly rates keep sub-cent precision", () => {
    expect(formatHourly(1_040_000, "EUR")).toBe("EUR 0.0104/h");
    expect(formatHourly(1_713_600, "EUR")).toBe("EUR 0.017136/h");
  });

  test("budget notes start at 80% and pause builders at 100%", () => {
    expect(budgetNote(1999, 2500)).toBe("");
    expect(budgetNote(2000, 2500)).toContain("80%");
    expect(budgetNote(2500, 2500)).toContain("paused");
  });

  test("builders past their lifetime or failed are flagged, deleted ones are not", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    const base = { id: "b", server_type: "cx33", location: "fsn1", provider_server_id: "1", deleted_at: null, max_lifetime_minutes: 120, error_code: null, cost: null };
    expect(builderWarning({ ...base, state: "busy", created_at: "2026-10-25T09:00:00Z" }, now)).toBe("past max lifetime");
    expect(builderWarning({ ...base, state: "failed", created_at: "2026-10-25T11:50:00Z" }, now)).toBe("failed, deleting");
    expect(builderWarning({ ...base, state: "deleted", created_at: "2026-10-25T09:00:00Z" }, now)).toBe("");
    expect(builderWarning({ ...base, state: "busy", created_at: "2026-10-25T11:30:00Z" }, now)).toBe("");
  });

  test("stopped, stopping and starting builders are never past their lifetime, running ones still are", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    const base = { id: "b", server_type: "cx33", location: "fsn1", provider_server_id: "1", deleted_at: null, max_lifetime_minutes: 120, error_code: null, cost: null, created_at: "2026-10-25T09:00:00Z" };
    for (const state of ["stopped", "stopping", "starting"]) expect(builderWarning({ ...base, state }, now)).toBe("");
    expect(builderWarning({ ...base, state: "ready" }, now)).toBe("past max lifetime");
    expect(builderWarning({ ...base, state: "failed" }, now)).toBe("failed, deleting");
  });

  test("a running builder's lifetime counts from running_since, from created_at only when it is absent", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    const sleeper = { id: "b", server_type: "cx33", location: "fsn1", provider_server_id: "1", deleted_at: null, max_lifetime_minutes: 120, error_code: null, cost: null, state: "busy", created_at: "2026-10-25T07:00:00Z" };
    expect(builderWarning({ ...sleeper, running_since: "2026-10-25T11:50:00Z" }, now)).toBe("");
    expect(builderWarning({ ...sleeper, running_since: "2026-10-25T09:50:00Z" }, now)).toBe("past max lifetime");
    expect(builderWarning({ ...sleeper, running_since: null }, now)).toBe("past max lifetime");
    expect(builderWarning(sleeper, now)).toBe("past max lifetime");
  });

  test("a sleep builder shows its open session in minutes, and its state while it has none", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    const sleeper = { id: "b", server_type: "cx33", location: "fsn1", provider_server_id: "1", deleted_at: null, max_lifetime_minutes: 120, error_code: null, cost: null, created_at: "2026-10-22T07:00:00Z" };
    expect(awakeSession({ ...sleeper, state: "busy", running_since: "2026-10-25T11:35:00Z" }, now)).toBe(25);
    expect(awakeSession({ ...sleeper, state: "stopped", running_since: null }, now)).toBe("stopped");
    expect(awakeSession({ ...sleeper, state: "starting", running_since: null }, now)).toBe("starting");
    expect(awakeSession({ ...sleeper, state: "ready", running_since: null }, now)).toBe("-");
  });

  test("--max-builder-age-days is sent as max_builder_age_days and must be 1 to 30", () => {
    const flags = { fallbackType: [] as string[] };
    expect(ephemeralFields({ ...flags, maxBuilderAgeDays: "14" })).toEqual({ max_builder_age_days: 14 });
    for (const bad of ["0", "31", "2.5", "week"]) expect(() => ephemeralFields({ ...flags, maxBuilderAgeDays: bad })).toThrow();
  });

  test("set rejects an out-of-range --max-builder-age-days with exit 2 before any request", async () => {
    const program = new Command().name("reoclo");
    registerBuildPools(program);
    const err = await program
      .parseAsync(["node", "reoclo", "build-pools", "set", "p", "--max-builder-age-days", "31"])
      .catch((e: unknown) => e);
    expect((err as { exitCode?: number }).exitCode).toBe(2);
  });

  test("a 404 from a cost route becomes the cost-data message and keeps exit 5", async () => {
    const err = await costRoute(() => Promise.reject(new NotFoundError("not found: /tenants/t/build-costs", "/tenants/t/build-costs"))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).message).toBe(COST_DATA_UNAVAILABLE);
    expect((err as NotFoundError).exitCode).toBe(5);
  });

  test("other cost route errors and results pass through unchanged", async () => {
    const boom = new ApiError(500, "boom", "/tenants/t/build-costs");
    expect(await costRoute(() => Promise.reject(boom)).catch((e: unknown) => e)).toBe(boom);
    expect(await costRoute(() => Promise.resolve(7))).toBe(7);
  });

  test("ephemeral create without a budget fails with exit 2 before any request", async () => {
    const program = new Command().name("reoclo");
    registerBuildPools(program);
    const err = await program
      .parseAsync(["node", "reoclo", "build-pools", "create", "--name", "p", "--mode", "ephemeral", "--cloud-credential", "c", "--location", "fsn1", "--server-type", "cx33"])
      .catch((e: unknown) => e);
    expect((err as { exitCode?: number }).exitCode).toBe(2);
  });

  test("persistent create refuses ephemeral flags with exit 2", async () => {
    const program = new Command().name("reoclo");
    registerBuildPools(program);
    const err = await program
      .parseAsync(["node", "reoclo", "build-pools", "create", "--name", "p", "--server", "s", "--budget", "5"])
      .catch((e: unknown) => e);
    expect((err as { exitCode?: number }).exitCode).toBe(2);
  });

  test("ls paginates with --skip and --limit", () => {
    const longs = sub("ls").options.map((o) => o.long);
    expect(longs).toContain("--skip");
    expect(longs).toContain("--limit");
  });

  test("create takes --name, repeatable --server and --max-concurrent", () => {
    const longs = sub("create").options.map((o) => o.long);
    for (const flag of ["--name", "--server", "--max-concurrent"]) expect(longs).toContain(flag);
  });

  test("create and set complete --server to servers", () => {
    expect(getCompletionSpec(sub("create"))?.flags).toEqual({ "--server": "servers" });
    expect(getCompletionSpec(sub("set"))?.flags).toEqual({ "--server": "servers" });
  });

  test("rm has --yes", () => {
    expect(sub("rm").options.map((o) => o.long)).toContain("--yes");
  });

  test("create without --server fails with exit 2 before any request", async () => {
    const program = new Command().name("reoclo");
    registerBuildPools(program);
    const err = await program.parseAsync(["node", "reoclo", "build-pools", "create", "--name", "p"]).catch((e: unknown) => e);
    expect((err as { exitCode?: number }).exitCode).toBe(2);
  });

  test("set with no fields fails with exit 2 before any request", async () => {
    const program = new Command().name("reoclo");
    registerBuildPools(program);
    const err = await program.parseAsync(["node", "reoclo", "build-pools", "set", "p"]).catch((e: unknown) => e);
    expect((err as { exitCode?: number }).exitCode).toBe(2);
  });
});
