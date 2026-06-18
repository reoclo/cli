// tests/unit/client/secrets.test.ts
import { describe, expect, test } from "bun:test";
import { mergeEnv } from "../../../src/client/secrets";

describe("mergeEnv", () => {
  test("resolved values win over base and undefined base entries are dropped", () => {
    const out = mergeEnv({ PATH: "/bin", A: undefined, B: "base" }, { B: "secret", C: "new" });
    expect(out).toEqual({ PATH: "/bin", B: "secret", C: "new" });
  });

  test("empty resolved leaves defined base entries unchanged", () => {
    const out = mergeEnv({ X: "x", Y: undefined }, {});
    expect(out).toEqual({ X: "x" });
  });

  test("empty base returns all resolved entries", () => {
    const out = mergeEnv({}, { A: "1", B: "2" });
    expect(out).toEqual({ A: "1", B: "2" });
  });

  test("resolved completely overrides all overlapping base keys", () => {
    const out = mergeEnv({ A: "old", B: "old" }, { A: "new", B: "new" });
    expect(out).toEqual({ A: "new", B: "new" });
  });
});
