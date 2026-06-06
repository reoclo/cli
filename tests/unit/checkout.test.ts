import { describe, expect, test } from "bun:test";
import { buildCloneUrl, assertSafeArg, shellQuote, buildFetchFlags } from "../../src/commands/checkout";

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

describe("shellQuote", () => {
  test("wraps a plain value in single quotes", () => {
    expect(shellQuote("blob:none")).toBe("'blob:none'");
    expect(shellQuote("src/*")).toBe("'src/*'");
  });
  test("escapes embedded single quotes with the POSIX dance", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
  test("neutralises shell metacharacters (no expansion)", () => {
    expect(shellQuote("$(id)")).toBe("'$(id)'");
    expect(shellQuote("; rm -rf /")).toBe("'; rm -rf /'");
  });
});

describe("buildFetchFlags", () => {
  test("shallow depth, no tags by default", () => {
    expect(buildFetchFlags({ depth: 1, fetchTags: false, filter: "" })).toBe(
      "--depth 1 --no-tags --force",
    );
  });
  test("depth 0 omits --depth (full history)", () => {
    expect(buildFetchFlags({ depth: 0, fetchTags: false, filter: "" })).toBe("--no-tags --force");
  });
  test("fetch_tags switches --no-tags to --tags", () => {
    expect(buildFetchFlags({ depth: 1, fetchTags: true, filter: "" })).toBe(
      "--depth 1 --tags --force",
    );
  });
  test("filter is shell-quoted and appended", () => {
    expect(buildFetchFlags({ depth: 1, fetchTags: false, filter: "blob:none" })).toBe(
      "--depth 1 --no-tags --filter='blob:none' --force",
    );
  });
});
