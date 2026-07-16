// tests/unit/commands/run.test.ts
import { describe, expect, test } from "bun:test";
import { collectCiMeta, selectProjectIds, splitRunArgs } from "../../../src/commands/run";
import { EXIT } from "../../../src/client/exit-codes";
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

describe("selectProjectIds", () => {
  const P = [
    { id: "id-a", name: "payments-production" },
    { id: "id-b", name: "shared-infra" },
  ];

  function codeOf(fn: () => unknown): number | undefined {
    try {
      fn();
    } catch (e) {
      return (e as { exitCode?: number }).exitCode;
    }
    return undefined;
  }

  test("no -p injects every granted project", () => {
    expect(selectProjectIds(P, [])).toEqual(["id-a", "id-b"]);
  });
  test("-p selects by name", () => {
    expect(selectProjectIds(P, ["payments-production"])).toEqual(["id-a"]);
  });
  test("-p selects by id", () => {
    expect(selectProjectIds(P, ["id-b"])).toEqual(["id-b"]);
  });
  test("-p is repeatable", () => {
    expect(selectProjectIds(P, ["payments-production", "shared-infra"])).toEqual(["id-a", "id-b"]);
  });
  test("a partial match still resolves the projects that did match", () => {
    expect(selectProjectIds(P, ["shared-infra", "not-granted"])).toEqual(["id-b"]);
  });

  // The reason RESOLUTION_FAILED exists: `run` passes the child's exit code
  // straight through, so GENERIC(1) here was indistinguishable from a child
  // script that merely exited 1 — the exact branch pipelines need most.
  test("a key with no grants fails with RESOLUTION_FAILED, never GENERIC", () => {
    expect(codeOf(() => selectProjectIds([], []))).toBe(EXIT.RESOLUTION_FAILED);
    expect(codeOf(() => selectProjectIds([], []))).not.toBe(EXIT.GENERIC);
  });
  test("-p naming an ungranted project fails with RESOLUTION_FAILED", () => {
    expect(codeOf(() => selectProjectIds(P, ["not-granted"]))).toBe(EXIT.RESOLUTION_FAILED);
    expect(codeOf(() => selectProjectIds(P, ["not-granted"]))).not.toBe(EXIT.GENERIC);
  });
  test("an ungranted project and a nonexistent one are indistinguishable", () => {
    // Deliberate: a key must not be able to enumerate projects it cannot read.
    expect(codeOf(() => selectProjectIds(P, ["definitely-not-real"]))).toBe(
      codeOf(() => selectProjectIds(P, ["also-not-real"])),
    );
  });
  test("fails closed — never returns an empty id list for the caller to resolve", () => {
    expect(() => selectProjectIds([], [])).toThrow();
    expect(() => selectProjectIds(P, ["nope"])).toThrow();
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
