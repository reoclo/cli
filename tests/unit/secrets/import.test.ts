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
