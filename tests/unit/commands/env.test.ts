import { describe, expect, test } from "bun:test";
import {
  buildOptionFields,
  buildOptionLabel,
  parseAssignments,
  setSummary,
  sourceLabel,
} from "../../../src/commands/env";

describe("buildOptionFields", () => {
  test("sends only the options the user named", () => {
    expect(buildOptionFields({})).toEqual({});
    expect(buildOptionFields({ publicBuild: true })).toEqual({ build_public: true });
    expect(buildOptionFields({ buildSecret: false })).toEqual({ build_secret: false });
  });

  test("refuses both options at once", () => {
    expect(() => buildOptionFields({ publicBuild: true, buildSecret: true })).toThrow(
      /both a public build value and a build secret/,
    );
  });
});

describe("parseAssignments", () => {
  test("KEY=VALUE pairs carry the named option", () => {
    expect(parseAssignments(["API_URL=https://a=b"], { publicBuild: true })).toEqual([
      { key: "API_URL", value: "https://a=b", build_public: true },
    ]);
  });

  test("with a secret project, KEY reads the same key and KEY=SECRET_KEY renames it", () => {
    expect(parseAssignments(["TOKEN", "CMS_TOKEN=CONTENTFUL_ACCESS_TOKEN"], { buildSecret: true }, "P1")).toEqual([
      { key: "TOKEN", source: "reference", secret_ref: { project_id: "P1", secret_key: "TOKEN" }, build_secret: true },
      {
        key: "CMS_TOKEN",
        source: "reference",
        secret_ref: { project_id: "P1", secret_key: "CONTENTFUL_ACCESS_TOKEN" },
        build_secret: true,
      },
    ]);
  });

  test("rejects malformed arguments with a misuse exit code", () => {
    expect(() => parseAssignments(["NOVALUE"], {})).toThrow(/expected KEY=VALUE/);
    expect(() => parseAssignments(["=x"], {}, "P1")).toThrow(/expected KEY or KEY=SECRET_KEY/);
    try {
      parseAssignments(["NOVALUE"], {});
    } catch (e) {
      expect((e as { exitCode?: number }).exitCode).toBe(2);
    }
  });
});

describe("env ls labels", () => {
  const base = { key: "K", updated_at: "2026-11-14T00:00:00Z" };

  test("BUILD column", () => {
    expect(buildOptionLabel({ ...base, build_public: true })).toBe("public");
    expect(buildOptionLabel({ ...base, build_secret: true })).toBe("secret");
    expect(buildOptionLabel(base)).toBe("-");
  });

  test("SOURCE column names the project and flags an unresolvable reference", () => {
    const ref = { project_id: "P1", secret_key: "TOKEN" };
    expect(sourceLabel({ ...base, source: "literal" })).toBe("value");
    expect(sourceLabel({ ...base, source: "reference", secret_ref: ref, project_name: "landing" })).toBe(
      "landing/TOKEN",
    );
    expect(sourceLabel({ ...base, source: "reference", secret_ref: ref, resolvable: false })).toBe(
      "P1/TOKEN (unresolvable)",
    );
  });
});

test("setSummary names the source and every option the user changed", () => {
  expect(setSummary({ key: "FOO", value: "x" })).toBe("✓ set FOO");
  expect(
    setSummary(
      { key: "T", source: "reference", secret_ref: { project_id: "P1", secret_key: "T" }, build_secret: true },
      "landing",
    ),
  ).toBe("✓ set T (from landing/T, build secret)");
  expect(setSummary({ key: "U", value: "x", build_public: false })).toBe("✓ set U (not a public build value)");
});
