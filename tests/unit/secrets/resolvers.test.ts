import { describe, expect, test } from "bun:test";
import { machineResolver } from "../../../src/secrets/resolvers";
import { ResolutionError } from "../../../src/secrets/template";
import type { HttpClient } from "../../../src/client/http";
import type { OpRef } from "../../../src/secrets/template";

/** Minimal path-routing fake HttpClient for the automation endpoints. */
function machineFake(opts: {
  accessible: { id: string; name: string; access: string }[];
  values: Record<string, Record<string, string>>; // projectId -> key -> value
  onOpenSession?: (body: unknown) => void;
}): HttpClient {
  const resolveClient = {
    post: (path: string, body: { project_ids: string[] }) => {
      if (path === "/secrets/resolve") {
        const pid = body.project_ids[0]!;
        return Promise.resolve({ values: opts.values[pid] ?? {} });
      }
      throw new Error(`unexpected ${path}`);
    },
  };
  return {
    get: (path: string) => {
      if (path === "/secrets/accessible-projects") return Promise.resolve(opts.accessible);
      throw new Error(`unexpected GET ${path}`);
    },
    post: (path: string, body: unknown) => {
      if (path === "/secrets/open-session") {
        opts.onOpenSession?.(body);
        return Promise.resolve({
          session_id: "s1",
          session_token: "rss_session",
          expires_at: "",
          project_ids: [],
        });
      }
      throw new Error(`unexpected POST ${path}`);
    },
    withToken: (_t: string) => resolveClient,
  } as unknown as HttpClient;
}

const ref = (vault: string, field: string): OpRef => ({ vault, item: "dep", field });

describe("machineResolver", () => {
  test("resolves per project so same key in two projects does not collide", async () => {
    const client = machineFake({
      accessible: [
        { id: "id-prod", name: "prod", access: "read" },
        { id: "id-stg", name: "staging", access: "read" },
      ],
      values: { "id-prod": { K: "prod-val" }, "id-stg": { K: "stg-val" } },
    });
    const resolved = await machineResolver(client, {})([ref("prod", "K"), ref("staging", "K")]);
    expect(resolved.get("prod")).toEqual({ K: "prod-val" });
    expect(resolved.get("staging")).toEqual({ K: "stg-val" });
  });

  test("passes CI meta into open-session", async () => {
    let seen: unknown;
    const client = machineFake({
      accessible: [{ id: "id-prod", name: "prod", access: "read" }],
      values: { "id-prod": { K: "v" } },
      onOpenSession: (b) => (seen = b),
    });
    await machineResolver(client, { commit_sha: "abc", workflow_run_id: "42" })([ref("prod", "K")]);
    expect(seen).toMatchObject({ commit_sha: "abc", workflow_run_id: "42" });
  });

  test("an ungranted project throws ResolutionError (exit 6)", async () => {
    const client = machineFake({ accessible: [], values: {} });
    let err: unknown;
    try { await machineResolver(client, {})([ref("prod", "K")]); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ResolutionError);
    expect((err as Error).message).toContain("prod");
  });

  test("no refs resolves to an empty map without any network call", async () => {
    const client = { get: () => { throw new Error("should not call"); } } as unknown as HttpClient;
    expect((await machineResolver(client, {})([])).size).toBe(0);
  });
});
