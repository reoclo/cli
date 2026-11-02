import { describe, expect, test } from "bun:test";
import {
  describeUsages,
  filterBySource,
  parseDetachSource,
  parseSourceFilter,
  planDetach,
  secretTableRows,
  syncConflictError,
  usageTableRows,
} from "../../../src/commands/secrets";
import { ApiError } from "../../../src/client/errors";
import type { SecretRead, SecretUsage } from "../../../src/client/secrets";

const rows: SecretRead[] = [
  { id: "1", key: "A", current_version: 1, source: "bitwarden", sync_status: "synced", last_synced_at: "2026-11-01T09:00:00Z" },
  { id: "2", key: "B", current_version: 2, source: "onepassword", sync_status: "orphaned", last_synced_at: null },
  { id: "3", key: "C", current_version: 1, source: "manual", sync_status: null, last_synced_at: null },
  { id: "4", key: "D", current_version: 1 },
];

describe("secrets ls --source", () => {
  test("filters by origin and treats a missing source as manual", () => {
    expect(filterBySource(rows, "bitwarden").map((r) => r.key)).toEqual(["A"]);
    expect(filterBySource(rows, "manual").map((r) => r.key)).toEqual(["C", "D"]);
    expect(filterBySource(rows).length).toBe(4);
  });

  test("rejects an unknown source", () => {
    expect(parseSourceFilter("onepassword")).toBe("onepassword");
    expect(() => parseSourceFilter("vault")).toThrow(/invalid --source 'vault'/);
  });

  test("table rows add SOURCE, SYNC and LAST SYNCED with - for null", () => {
    const table = secretTableRows(rows);
    expect(table[0]).toMatchObject({ source: "bitwarden", sync_status: "synced", last_synced_at: "2026-11-01T09:00:00Z" });
    expect(table[1]).toMatchObject({ source: "onepassword", sync_status: "orphaned", last_synced_at: "-" });
    expect(table[2]).toMatchObject({ source: "manual", sync_status: "-", last_synced_at: "-" });
    expect(table[3]).toMatchObject({ source: "manual", sync_status: "-" });
  });
});

describe("secrets detach flags", () => {
  test("a key detaches one secret", () => {
    expect(planDetach("A", {})).toEqual({ mode: "one", key: "A" });
  });

  test("--all needs --source and refuses a key", () => {
    expect(planDetach(undefined, { all: true, source: "bitwarden" })).toEqual({ mode: "all", source: "bitwarden" });
    expect(() => planDetach(undefined, { all: true })).toThrow(/--all needs --source/);
    expect(() => planDetach("A", { all: true, source: "bitwarden" })).toThrow(/not both/);
  });

  test("only synced sources are accepted, and --source needs --all", () => {
    expect(() => parseDetachSource("manual")).toThrow(/bitwarden, onepassword/);
    expect(() => planDetach("A", { source: "bitwarden" })).toThrow(/only works with --all/);
    expect(() => planDetach(undefined, {})).toThrow(/pass a key/);
  });
});

describe("secrets rm 409 and usage output", () => {
  test("409 keeps the API reason and adds the detach hint", () => {
    const e = syncConflictError(new ApiError(409, "secret is synced from bitwarden", "/x"), "DB_URL", "prod");
    expect(e.status).toBe(409);
    expect(e.message).toBe("secret is synced from bitwarden");
    expect(e.hint).toBe("run `reoclo secrets detach DB_URL --project prod` or pass --detach");
  });

  const usages: SecretUsage[] = [
    { kind: "application", id: "a1", name: "web", via: "env_reference", env_var: "DB_URL" },
    { kind: "stack", id: "s1", name: "staging", via: "project_binding", env_var: null },
  ];

  test("usage table rows show - for a missing env var", () => {
    expect(usageTableRows(usages)).toEqual([
      { kind: "application", name: "web", via: "env_reference", env_var: "DB_URL" },
      { kind: "stack", name: "staging", via: "project_binding", env_var: "-" },
    ]);
  });

  test("rm warning lists each usage", () => {
    expect(describeUsages(usages)).toEqual([
      "  application web (env_reference, DB_URL)",
      "  stack staging (project_binding)",
    ]);
  });
});
