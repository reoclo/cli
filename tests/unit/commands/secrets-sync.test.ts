import { describe, expect, test } from "bun:test";
import {
  describeUsages,
  extractSyncWarning,
  filterBySource,
  orphanTableRows,
  parseDetachSource,
  parseSourceFilter,
  planDetach,
  secretTableRows,
  syncConflictError,
  usageTableRows,
} from "../../../src/commands/secrets";
import { ApiError } from "../../../src/client/errors";
import { listOrphanedSecrets } from "../../../src/client/secrets";
import type { HttpClient } from "../../../src/client/http";
import type { OrphanedSecret, SecretProjectRead, SecretRead, SecretUsage } from "../../../src/client/secrets";

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

describe("secrets rm still-syncing warning", () => {
  const detail =
    "This secret is synced from an external provider and is read-only. Detach it first to edit." +
    " The Bitwarden connection is still syncing this secret, so a deleted or edited copy would be overwritten or come back on the next sync. Detach it first, which also stops the sync from recreating it.";

  test("splits the still-syncing sentence off the API detail", () => {
    const { base, warning } = extractSyncWarning(detail);
    expect(base).toBe("This secret is synced from an external provider and is read-only. Detach it first to edit.");
    expect(warning).toMatch(/^The Bitwarden connection is still syncing this secret/);
    expect(warning).toMatch(/stops the sync from recreating it\.$/);
  });

  test("leaves a plain 409 detail alone", () => {
    const plain = "This secret is synced from an external provider and is read-only. Detach it first to edit.";
    expect(extractSyncWarning(plain)).toEqual({ base: plain, warning: null });
  });

  test("recognises the 1Password wording", () => {
    const { warning } = extractSyncWarning("read-only. The 1Password connection is still syncing this secret, so x.");
    expect(warning).toBe("The 1Password connection is still syncing this secret, so x.");
  });
});

describe("secrets orphans", () => {
  const projects: SecretProjectRead[] = [{ id: "p1", name: "prod" }];
  const orphans: OrphanedSecret[] = [
    { id: "1", key: "DB_URL", current_version: 1, source: "bitwarden", sync_status: "synced", project_id: "p1", provider: "bitwarden", connection_id: "c1" },
    { id: "2", key: "API_KEY", current_version: 1, source: "onepassword", sync_status: "synced", project_id: "p9", provider: "onepassword", connection_id: null },
  ];

  test("table rows name the project when known and fall back to its id", () => {
    expect(orphanTableRows(orphans, projects)).toEqual([
      { key: "DB_URL", project: "prod", provider: "bitwarden", connection_id: "c1" },
      { key: "API_KEY", project: "p9", provider: "onepassword", connection_id: "-" },
    ]);
  });

  test("lists across the tenant, or narrows with project_id", async () => {
    const paths: string[] = [];
    const client = {
      get: (path: string) => {
        paths.push(path);
        return Promise.resolve(orphans);
      },
    } as unknown as HttpClient;
    expect(await listOrphanedSecrets(client, "t1")).toEqual(orphans);
    await listOrphanedSecrets(client, "t1", "p 1");
    expect(paths).toEqual(["/tenants/t1/secrets/orphans", "/tenants/t1/secrets/orphans?project_id=p%201"]);
  });
});
