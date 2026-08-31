import { describe, expect, test } from "bun:test";
import { parseKeySpecs } from "../../../src/commands/secrets";

describe("parseKeySpecs", () => {
  test("parses KEY and KEY=NEW_NAME forms", () => {
    expect(parseKeySpecs(["DATABASE_URL", "MINIO_ROOT_USER=S3_ACCESS_KEY_ID"])).toEqual([
      { key: "DATABASE_URL", env_name: null },
      { key: "MINIO_ROOT_USER", env_name: "S3_ACCESS_KEY_ID" },
    ]);
  });

  test("empty input selects every key", () => {
    expect(parseKeySpecs([])).toEqual([]);
  });

  test("rejects an invalid rename", () => {
    expect(() => parseKeySpecs(["KEY=not-valid"])).toThrow(/must match/);
  });

  test("rejects an empty key", () => {
    expect(() => parseKeySpecs(["=NAME"])).toThrow(/key/i);
  });
});
