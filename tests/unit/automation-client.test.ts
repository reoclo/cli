import { describe, expect, test } from "bun:test";
import {
  execOnServer,
  pollBudgetAttempts,
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
      post: <T>(path: string, body?: unknown): Promise<T> => {
        calls.push({ method: "POST", path, body });
        return Promise.resolve(posts[pi++] as T);
      },
      get: <T>(path: string): Promise<T> => {
        calls.push({ method: "GET", path });
        return Promise.resolve(gets[gi++] as T);
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

describe("execOnServer interrupted by a signal", () => {
  function exitCodeOf(err: unknown): number | undefined {
    return (err as { exitCode?: number }).exitCode;
  }

  test("cancels the operation on the server and exits with the signal's code", async () => {
    const abort = new AbortController();
    const { client, calls } = stubClient(
      [{ operation_id: "op3", status: "running" }, {}],
      [{ status: "running" }],
    );
    // The first poll sleeps; the signal arrives while the command runs.
    const sleep = () => {
      abort.abort(143);
      return Promise.resolve();
    };

    const err = await execOnServer(client, { server_id: UUID, command: "slow" }, sleep, abort.signal).catch(
      (e: unknown) => e,
    );

    expect(exitCodeOf(err)).toBe(143);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /exec",
      "GET /operations/op3",
      "POST /operations/op3/cancel",
    ]);
  });

  test("a signal that arrives before the first poll still cancels the operation", async () => {
    const abort = new AbortController();
    const { client, calls } = stubClient([{ operation_id: "op4", status: "running" }, {}], []);
    abort.abort();

    const err = await execOnServer(client, { server_id: UUID, command: "slow" }, async () => {}, abort.signal).catch(
      (e: unknown) => e,
    );

    expect(exitCodeOf(err)).toBe(130);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /exec", "POST /operations/op4/cancel"]);
  });

  test("a cancel the API refuses still ends the command with the signal's code", async () => {
    const abort = new AbortController();
    abort.abort(129);
    const calls: string[] = [];
    const client = {
      post: <T>(path: string): Promise<T> => {
        calls.push(path);
        return path === "/exec"
          ? Promise.resolve({ operation_id: "op5", status: "running" } as T)
          : Promise.reject(new Error("API unreachable"));
      },
      get: <T>(): Promise<T> => Promise.reject(new Error("not polled")),
    };

    const err = await execOnServer(client, { server_id: UUID, command: "slow" }, async () => {}, abort.signal).catch(
      (e: unknown) => e,
    );

    expect(exitCodeOf(err)).toBe(129);
    expect(calls).toEqual(["/exec", "/operations/op5/cancel"]);
  });
});

describe("pollBudgetAttempts", () => {
  test("scales the poll window with the command timeout (+margin)", () => {
    // 900s timeout + 60s margin = 960s window @2s = 480 polls (was capped at 300).
    expect(pollBudgetAttempts(900)).toBe(480);
  });

  test("falls back to the 600s default when no timeout is given", () => {
    // (600 + 60) * 1000 / 2000 = 330.
    expect(pollBudgetAttempts(undefined)).toBe(330);
    expect(pollBudgetAttempts(0)).toBe(330);
    expect(pollBudgetAttempts(-5)).toBe(330);
  });

  test("never drops below the historical 300-attempt floor", () => {
    expect(pollBudgetAttempts(60)).toBe(300); // (60+60)*1000/2000 = 60 -> floored to 300
  });

  test("honors a custom interval", () => {
    expect(pollBudgetAttempts(900, 1000)).toBe(960);
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
