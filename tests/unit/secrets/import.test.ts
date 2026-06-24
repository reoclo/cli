import { describe, expect, test } from "bun:test";
import {
  mapAndValidate,
  partitionExisting,
  chunk,
  BULK_CHUNK_SIZE,
} from "../../../src/secrets/import";

describe("mapAndValidate", () => {
  test("maps key/value/note and omits empty/null notes", () => {
    const { creates, emptyKeys, duplicateKeys } = mapAndValidate([
      { key: "A", value: "1", note: "keep" },
      { key: "B", value: "2", note: null },
      { key: "C", value: "3", note: "" },
    ]);
    expect(creates).toEqual([
      { key: "A", value: "1", note: "keep" },
      { key: "B", value: "2" },
      { key: "C", value: "3" },
    ]);
    expect(emptyKeys).toEqual([]);
    expect(duplicateKeys).toEqual([]);
  });

  test("skips empty-value secrets and records their keys", () => {
    const { creates, emptyKeys } = mapAndValidate([
      { key: "A", value: "1" },
      { key: "EMPTY", value: "" },
    ]);
    expect(creates.map((c) => c.key)).toEqual(["A"]);
    expect(emptyKeys).toEqual(["EMPTY"]);
  });

  test("detects in-batch duplicate keys (keeps first, reports repeats)", () => {
    const { creates, duplicateKeys } = mapAndValidate([
      { key: "A", value: "1" },
      { key: "A", value: "2" },
      { key: "B", value: "3" },
    ]);
    expect(creates.map((c) => c.key)).toEqual(["A", "B"]);
    expect(duplicateKeys).toEqual(["A"]);
  });
});

describe("partitionExisting", () => {
  test("splits creates into fresh vs conflicting by existing-key set", () => {
    const creates = [
      { key: "A", value: "1" },
      { key: "B", value: "2" },
      { key: "C", value: "3" },
    ];
    const { fresh, conflicting } = partitionExisting(creates, new Set(["B"]));
    expect(fresh.map((c) => c.key)).toEqual(["A", "C"]);
    expect(conflicting).toEqual(["B"]);
  });
});

describe("chunk", () => {
  test("splits into chunks of the given size, last is the remainder", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  test("empty input → no chunks", () => {
    expect(chunk([], 2)).toEqual([]);
  });
  test("BULK_CHUNK_SIZE matches the endpoint cap", () => {
    expect(BULK_CHUNK_SIZE).toBe(500);
  });
});

import {
  runImport,
  importReportJson,
  importReportText,
  type ImportDeps,
  type ImportOptions,
} from "../../../src/secrets/import";
import type { ImportedSecret, SecretSource } from "../../../src/secrets/types";
import type { SecretCreate } from "../../../src/client/secrets";

function fakeSource(secrets: ImportedSecret[]): SecretSource {
  return { name: "bitwarden", read: () => Promise.resolve(secrets) };
}

function deps(
  over: Partial<ImportDeps> & { source: SecretSource },
): { deps: ImportDeps; written: SecretCreate[][] } {
  const written: SecretCreate[][] = [];
  return {
    written,
    deps: {
      projectLabel: "prod",
      listExistingKeys: () => Promise.resolve([]),
      bulkCreate: (s) => {
        written.push(s);
        return Promise.resolve();
      },
      ...over,
    },
  };
}

const opts = (o: Partial<ImportOptions> = {}): ImportOptions => ({
  skipExisting: false,
  dryRun: false,
  ...o,
});

async function importError(d: ImportDeps, o: ImportOptions): Promise<Error> {
  try {
    await runImport(d, o);
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected runImport to reject, but it resolved");
}

describe("runImport", () => {
  test("imports fresh secrets and skips empties", async () => {
    const { deps: d, written } = deps({
      source: fakeSource([
        { key: "A", value: "1" },
        { key: "B", value: "2" },
        { key: "EMPTY", value: "" },
      ]),
    });
    const r = await runImport(d, opts());
    expect(r.imported).toEqual(["A", "B"]);
    expect(r.skippedEmpty).toEqual(["EMPTY"]);
    expect(r.skippedExisting).toEqual([]);
    expect(written).toEqual([[{ key: "A", value: "1" }, { key: "B", value: "2" }]]);
  });

  test("in-batch duplicate keys abort before any write", async () => {
    const { deps: d, written } = deps({
      source: fakeSource([
        { key: "A", value: "1" },
        { key: "A", value: "2" },
      ]),
    });
    expect((await importError(d, opts())).message).toMatch(/duplicate key/i);
    expect(written).toEqual([]);
  });

  test("default policy aborts on conflicts without writing", async () => {
    const { deps: d, written } = deps({
      source: fakeSource([{ key: "A", value: "1" }, { key: "B", value: "2" }]),
      listExistingKeys: () => Promise.resolve(["B"]),
    });
    expect((await importError(d, opts())).message).toMatch(/already exist.*B/s);
    expect(written).toEqual([]);
  });

  test("--skip-existing drops conflicts and records them", async () => {
    const { deps: d, written } = deps({
      source: fakeSource([{ key: "A", value: "1" }, { key: "B", value: "2" }]),
      listExistingKeys: () => Promise.resolve(["B"]),
    });
    const r = await runImport(d, opts({ skipExisting: true }));
    expect(r.imported).toEqual(["A"]);
    expect(r.skippedExisting).toEqual(["B"]);
    expect(written).toEqual([[{ key: "A", value: "1" }]]);
  });

  test("--dry-run writes nothing and reports the plan", async () => {
    const { deps: d, written } = deps({
      source: fakeSource([{ key: "A", value: "1" }, { key: "B", value: "2" }]),
      listExistingKeys: () => Promise.resolve(["B"]),
    });
    const r = await runImport(d, opts({ skipExisting: true, dryRun: true }));
    expect(r.dryRun).toBe(true);
    expect(r.imported).toEqual(["A"]);
    expect(r.skippedExisting).toEqual(["B"]);
    expect(written).toEqual([]);
  });

  test("chunks writes at the 500 cap", async () => {
    const many: ImportedSecret[] = Array.from({ length: 501 }, (_, i) => ({
      key: `K${i}`,
      value: "v",
    }));
    const { deps: d, written } = deps({ source: fakeSource(many) });
    const r = await runImport(d, opts());
    expect(written).toHaveLength(2);
    expect(written[0]).toHaveLength(500);
    expect(written[1]).toHaveLength(1);
    expect(r.imported).toHaveLength(501);
  });

  test("a failed chunk reports how many landed and how to resume", async () => {
    const many: ImportedSecret[] = Array.from({ length: 501 }, (_, i) => ({
      key: `K${i}`,
      value: "v",
    }));
    let call = 0;
    const { deps: d } = deps({
      source: fakeSource(many),
      bulkCreate: () => {
        call += 1;
        if (call === 2) throw new Error("[403] secret quota exceeded");
        return Promise.resolve();
      },
    });
    expect((await importError(d, opts())).message).toMatch(/imported 500 of 501.*--skip-existing/s);
  });
});

describe("report formatters", () => {
  const base = {
    source: "bitwarden",
    project: "prod",
    imported: ["A", "B"],
    skippedExisting: ["X"],
    skippedEmpty: ["E"],
  };

  test("importReportJson uses snake_case keys, values absent", () => {
    expect(importReportJson({ ...base, dryRun: false })).toEqual({
      source: "bitwarden",
      project: "prod",
      imported: ["A", "B"],
      skipped_existing: ["X"],
      skipped_empty: ["E"],
      dry_run: false,
    });
  });

  test("importReportText summarizes counts for a real run", () => {
    const text = importReportText({ ...base, dryRun: false });
    expect(text).toContain("Imported 2");
    expect(text).toContain("prod");
    expect(text).toContain("1 existing");
    expect(text).toContain("1 empty");
  });

  test("importReportText marks a dry run and mentions the quota caveat", () => {
    const text = importReportText({ ...base, dryRun: true });
    expect(text).toMatch(/dry run/i);
    expect(text).toMatch(/would import 2/i);
    expect(text).toMatch(/quota/i);
  });
});
