import { describe, expect, test } from "bun:test";
import { buildCloneUrl, assertSafeArg } from "../../src/commands/checkout";

describe("buildCloneUrl", () => {
  test("github host with token uses x-access-token form", () => {
    expect(buildCloneUrl("https://github.com", "acme/app", "ght_xxx")).toBe(
      "https://x-access-token:ght_xxx@github.com/acme/app.git",
    );
  });

  test("Gitea host is honored, not rewritten to github.com (the action bug)", () => {
    expect(buildCloneUrl("https://git.boxpositron.dev", "reoclo/app", "tok")).toBe(
      "https://x-access-token:tok@git.boxpositron.dev/reoclo/app.git",
    );
  });

  test("no token → plain https url, no credentials", () => {
    expect(buildCloneUrl("https://github.com", "acme/app", "")).toBe(
      "https://github.com/acme/app.git",
    );
  });

  test("empty serverUrl falls back to github.com", () => {
    expect(buildCloneUrl("", "acme/app", "")).toBe("https://github.com/acme/app.git");
  });
});

describe("assertSafeArg", () => {
  test("accepts normal refs, repos, tags, and empty", () => {
    expect(() => assertSafeArg("refs/heads/main", "ref")).not.toThrow();
    expect(() => assertSafeArg("acme/app", "repository")).not.toThrow();
    expect(() => assertSafeArg("v1.2.3", "ref")).not.toThrow();
    expect(() => assertSafeArg("", "ref")).not.toThrow();
  });
  test("rejects shell metacharacters", () => {
    expect(() => assertSafeArg("$(curl evil)", "ref")).toThrow(/not allowed/);
    expect(() => assertSafeArg('"; rm -rf / #', "ref")).toThrow(/not allowed/);
    expect(() => assertSafeArg("`id`", "ref")).toThrow(/not allowed/);
    expect(() => assertSafeArg("a b", "ref")).toThrow(/not allowed/);
  });
});
