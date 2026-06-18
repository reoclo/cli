// tests/unit/commands/run.test.ts
import { describe, expect, test } from "bun:test";
import { collectCiMeta, splitRunArgs } from "../../../src/commands/run";
import { detectKeyType } from "../../../src/client/routing";

describe("splitRunArgs", () => {
  test("takes the command + args verbatim", () => {
    expect(splitRunArgs(["node", "x.js", "--flag"])).toEqual({ cmd: "node", args: ["x.js", "--flag"] });
  });
  test("returns cmd with no args when only one element", () => {
    expect(splitRunArgs(["echo"])).toEqual({ cmd: "echo", args: [] });
  });
  test("throws on empty", () => {
    let err: unknown;
    try {
      splitRunArgs([]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
  });
});

describe("collectCiMeta", () => {
  test("reads github env", () => {
    expect(collectCiMeta({ GITHUB_SHA: "abc", GITHUB_RUN_ID: "42" }, undefined))
      .toEqual({ commit_sha: "abc", workflow_run_id: "42" });
  });
  test("--commit overrides", () => {
    expect(collectCiMeta({ GITHUB_SHA: "abc" }, "deadbeef").commit_sha).toBe("deadbeef");
  });
  test("returns empty object when no env and no flag", () => {
    expect(collectCiMeta({}, undefined)).toEqual({});
  });
  test("reads only GITHUB_RUN_ID when no SHA", () => {
    expect(collectCiMeta({ GITHUB_RUN_ID: "99" }, undefined)).toEqual({ workflow_run_id: "99" });
  });
});

describe("detectKeyType rss_ routing fix", () => {
  test("rss_ token routes to automation", () => {
    expect(detectKeyType("rss_abc123")).toBe("automation");
  });
  test("rca_ still routes to automation", () => {
    expect(detectKeyType("rca_abc123")).toBe("automation");
  });
  test("rk_a_ still routes to automation", () => {
    expect(detectKeyType("rk_a_abc123")).toBe("automation");
  });
  test("oauth token still routes to tenant", () => {
    expect(detectKeyType("eyJhbGciOiJSUzI1NiJ9")).toBe("tenant");
  });
});
