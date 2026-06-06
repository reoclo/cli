import { describe, expect, test } from "bun:test";
import {
  execOnServer,
  requireServerUuid,
  requireAutomationKey,
} from "../../src/ci/automation-client";

const UUID = "11111111-2222-3333-4444-555555555555";

function stubClient(posts: unknown[], gets: unknown[]) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let pi = 0;
  let gi = 0;
  return {
    calls,
    client: {
      post: async <T>(path: string, body?: unknown): Promise<T> => {
        calls.push({ method: "POST", path, body });
        return posts[pi++] as T;
      },
      get: async <T>(path: string): Promise<T> => {
        calls.push({ method: "GET", path });
        return gets[gi++] as T;
      },
    },
  };
}

describe("execOnServer", () => {
  test("inline-complete response returns result without polling, hits flat /exec", async () => {
    const { client, calls } = stubClient(
      [{ operation_id: "op1", status: "completed", exit_code: 0, stdout: "ok", stderr: "", duration_ms: 12 }],
      [],
    );
    const r = await execOnServer(client, { server_id: UUID, command: "echo ok" });
    expect(r).toEqual({ operation_id: "op1", exit_code: 0, stdout: "ok", stderr: "", duration_ms: 12 });
    expect(calls[0]).toEqual({ method: "POST", path: "/exec", body: { server_id: UUID, command: "echo ok" } });
  });

  test("running response polls /operations/{id} until terminal", async () => {
    const { client, calls } = stubClient(
      [{ operation_id: "op2", status: "running" }],
      [
        { status: "running" },
        { status: "completed", result: { exit_code: 3, stdout: "x", stderr: "y", duration_ms: 5 } },
      ],
    );
    const r = await execOnServer(client, { server_id: UUID, command: "slow" }, async () => {});
    expect(r.exit_code).toBe(3);
    expect(calls[1]).toEqual({ method: "GET", path: "/operations/op2" });
  });
});

describe("requireServerUuid", () => {
  test("returns the UUID unchanged", () => {
    expect(requireServerUuid(UUID)).toBe(UUID);
  });
  test("throws exit-coded error for a non-UUID name", () => {
    expect(() => requireServerUuid("my-server")).toThrow(/server UUID/);
  });
});

describe("requireAutomationKey", () => {
  test("throws when tokenType is not automation", () => {
    expect(() => requireAutomationKey({ tokenType: "tenant" } as never)).toThrow(/automation key/);
  });
  test("passes for automation tokenType", () => {
    expect(() => requireAutomationKey({ tokenType: "automation" } as never)).not.toThrow();
  });
});
