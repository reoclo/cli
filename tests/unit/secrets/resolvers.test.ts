import { describe, expect, test } from "bun:test";
import { humanResolver, machineResolver } from "../../../src/secrets/resolvers";
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
    // machineLane() pins the automation prefix via withPrefix() before every
    // call; this fake is path-only (no baseUrl/prefix concatenation), so it
    // just returns itself.
    withPrefix() {
      return this;
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
    withPrefix() {
      return this;
    },
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

  // Fix round 1 (finding 2): `--env-file`/`secrets inject` never call
  // selectProjectIds, so this is the message a machine user actually sees
  // when their op:// template references a server-restricted project (the
  // API omits those from accessibleProjects entirely, so this is the
  // guaranteed outcome, not an edge case). Pin the "this credential" wording
  // and the server-restricted caveat added alongside selectProjectIds's.
  test("an ungranted project's message names the credential and the restricted-server caveat", async () => {
    const client = machineFake({ accessible: [], values: {} });
    let message = "";
    try {
      await machineResolver(client, {})([ref("prod", "K")]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("this credential");
    expect(message.toLowerCase()).toContain("restricted to specific servers");
  });

  test("no refs resolves to an empty map without any network call", async () => {
    const client = { get: () => { throw new Error("should not call"); } } as unknown as HttpClient;
    expect((await machineResolver(client, {})([])).size).toBe(0);
  });
});

/** Minimal path-routing fake HttpClient for the human (OAuth) endpoints. */
function humanFake(opts: {
  projects: { id: string; name: string }[];
  secrets: Record<string, { id: string; key: string; current_version: number }[]>; // pid -> secrets
  reveal: Record<string, { key: string; value: string }>; // secretId -> revealed
  onReveal?: (id: string) => void;
}): HttpClient {
  return {
    get: (path: string) => {
      if (path.endsWith("/secret-projects")) return Promise.resolve(opts.projects);
      const m = path.match(/secret-projects\/([^/]+)\/secrets$/);
      if (m) return Promise.resolve(opts.secrets[m[1]!] ?? []);
      throw new Error(`unexpected GET ${path}`);
    },
    post: (path: string) => {
      const m = path.match(/secrets\/([^/]+)\/reveal$/);
      if (m) {
        opts.onReveal?.(m[1]!);
        return Promise.resolve(opts.reveal[m[1]!]);
      }
      throw new Error(`unexpected POST ${path}`);
    },
  } as unknown as HttpClient;
}

describe("humanResolver", () => {
  test("reveals only the referenced keys, grouped per project", async () => {
    const revealed: string[] = [];
    const client = humanFake({
      projects: [{ id: "pid1", name: "prod" }],
      secrets: { pid1: [
        { id: "s-a", key: "A", current_version: 1 },
        { id: "s-b", key: "B", current_version: 1 },
      ] },
      reveal: { "s-a": { key: "A", value: "aaa" } },
      onReveal: (id) => revealed.push(id),
    });
    const resolved = await humanResolver(client, "tid")([ref("prod", "A")]);
    expect(resolved.get("prod")).toEqual({ A: "aaa" });
    expect(revealed).toEqual(["s-a"]); // B never revealed
  });

  test("an unknown project throws ResolutionError", async () => {
    const client = humanFake({ projects: [], secrets: {}, reveal: {} });
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(humanResolver(client, "tid")([ref("prod", "A")])).rejects.toBeInstanceOf(ResolutionError);
  });
});
