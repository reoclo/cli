import { describe, expect, test } from "bun:test";
import { parseSetFlags } from "../../../src/util/parse-set";

describe("parseSetFlags", () => {
  test("empty input returns empty object", () => {
    expect(parseSetFlags([])).toEqual({});
  });

  test("flat key=value", () => {
    expect(parseSetFlags(["name=hello"])).toEqual({ name: "hello" });
  });

  test("dot-path nests", () => {
    expect(parseSetFlags(["a.b.c=v"])).toEqual({ a: { b: { c: "v" } } });
  });

  test("multiple keys merge at top level", () => {
    expect(parseSetFlags(["a=1", "b=2"])).toEqual({ a: 1, b: 2 });
  });

  test("dot-paths sharing a prefix merge correctly", () => {
    expect(parseSetFlags(["deploy.replicas=3", "deploy.host_port=8080"])).toEqual({
      deploy: { replicas: 3, host_port: 8080 },
    });
  });

  test("numeric strings coerce to numbers", () => {
    expect(parseSetFlags(["n=42"])).toEqual({ n: 42 });
  });

  test('"true"/"false" coerce to booleans', () => {
    expect(parseSetFlags(["a=true", "b=false"])).toEqual({ a: true, b: false });
  });

  test("non-numeric strings stay as strings", () => {
    expect(parseSetFlags(["s=hello world"])).toEqual({ s: "hello world" });
  });

  test("values with = preserved after first =", () => {
    expect(parseSetFlags(["x=a=b=c"])).toEqual({ x: "a=b=c" });
  });

  test("last-write-wins for same path", () => {
    expect(parseSetFlags(["a.b=1", "a.b=2"])).toEqual({ a: { b: 2 } });
  });

  test("malformed input (no =) throws documented message", () => {
    expect(() => parseSetFlags(["bare"])).toThrow(
      "invalid --set value: 'bare' (expected key=value)",
    );
  });
});
