import { describe, expect, test } from "bun:test";
import { bitwardenSource } from "../../../src/secrets/sources/bitwarden";
import type { CommandResult } from "../../../src/secrets/sources/exec";
import type { SecretSource } from "../../../src/secrets/types";

const TOKEN_ENV = { BWS_ACCESS_TOKEN: "tok" };

/** Build a fake runner that returns canned results keyed by the bws subcommand
 *  (cmd[1]: "secret" | "project"). Records every invocation. */
function fakeRunner(
  bySub: Record<string, CommandResult>,
): { run: (cmd: string[]) => Promise<CommandResult>; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (cmd: string[]): Promise<CommandResult> => {
      calls.push(cmd);
      const handler = bySub[cmd[1] ?? ""];
      if (!handler) return Promise.reject(new Error(`unexpected bws call: ${cmd.join(" ")}`));
      return Promise.resolve(handler);
    },
  };
}

/** Invoke read() and return the Error it rejects with. The repo lint rejects
 *  `await expect(...).rejects.toThrow()` (Bun types that matcher non-thenable),
 *  so we use the try/catch idiom instead. */
async function readError(src: SecretSource): Promise<Error> {
  try {
    await src.read();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected read() to reject, but it resolved");
}

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });

describe("bitwardenSource.read", () => {
  test("normalizes bws secret list to {key,value,note}", async () => {
    const f = fakeRunner({
      secret: ok(
        JSON.stringify([
          { id: "1", key: "API_KEY", value: "abc", note: "prod" },
          { id: "2", key: "DB_URL", value: "postgres://x", note: null },
        ]),
      ),
    });
    const src = bitwardenSource({}, { run: f.run, env: TOKEN_ENV });
    const out = await src.read();
    expect(out).toEqual([
      { key: "API_KEY", value: "abc", note: "prod" },
      { key: "DB_URL", value: "postgres://x", note: null },
    ]);
    // no --bws-project → no positional project id, no project-list call
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toEqual(["bws", "secret", "list", "--output", "json"]);
  });

  test("empty list returns []", async () => {
    const f = fakeRunner({ secret: ok("[]") });
    const out = await bitwardenSource({}, { run: f.run, env: TOKEN_ENV }).read();
    expect(out).toEqual([]);
  });

  test("--bws-project as a UUID is passed as the positional project id", async () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    const f = fakeRunner({ secret: ok("[]") });
    await bitwardenSource({ bwsProject: uuid }, { run: f.run, env: TOKEN_ENV }).read();
    expect(f.calls).toHaveLength(1); // no project-list lookup
    expect(f.calls[0]).toEqual(["bws", "secret", "list", uuid, "--output", "json"]);
  });

  test("--bws-project as a name resolves to its id via project list", async () => {
    const f = fakeRunner({
      project: ok(JSON.stringify([{ id: "pid-9", name: "prod" }, { id: "pid-1", name: "dev" }])),
      secret: ok("[]"),
    });
    await bitwardenSource({ bwsProject: "prod" }, { run: f.run, env: TOKEN_ENV }).read();
    expect(f.calls[0]).toEqual(["bws", "project", "list", "--output", "json"]);
    expect(f.calls[1]).toEqual(["bws", "secret", "list", "pid-9", "--output", "json"]);
  });

  test("ambiguous project name throws", async () => {
    const f = fakeRunner({
      project: ok(JSON.stringify([{ id: "a", name: "prod" }, { id: "b", name: "prod" }])),
    });
    const src = bitwardenSource({ bwsProject: "prod" }, { run: f.run, env: TOKEN_ENV });
    expect((await readError(src)).message).toMatch(/multiple Bitwarden projects named "prod"/);
  });

  test("unknown project name throws", async () => {
    const f = fakeRunner({ project: ok(JSON.stringify([{ id: "a", name: "dev" }])) });
    const src = bitwardenSource({ bwsProject: "prod" }, { run: f.run, env: TOKEN_ENV });
    expect((await readError(src)).message).toMatch(/no Bitwarden project named "prod"/);
  });

  test("missing bws binary (ENOENT) throws an install hint", async () => {
    const run = (): Promise<CommandResult> =>
      Promise.reject(Object.assign(new Error("spawn bws ENOENT"), { code: "ENOENT" }));
    const src = bitwardenSource({}, { run, env: TOKEN_ENV });
    expect((await readError(src)).message).toMatch(/bws.*not found|install/i);
  });

  test("non-zero exit surfaces bws stderr", async () => {
    const f = fakeRunner({
      secret: { code: 1, stdout: "", stderr: "[401] invalid_client" },
    });
    const src = bitwardenSource({}, { run: f.run, env: TOKEN_ENV });
    expect((await readError(src)).message).toMatch(/\[401\] invalid_client/);
  });

  test("non-JSON stdout throws a guarded parse error", async () => {
    const f = fakeRunner({ secret: ok("not json at all") });
    const src = bitwardenSource({}, { run: f.run, env: TOKEN_ENV });
    expect((await readError(src)).message).toMatch(/could not parse/i);
  });

  test("missing BWS_ACCESS_TOKEN fails fast without invoking bws", async () => {
    const f = fakeRunner({ secret: ok("[]") });
    const src = bitwardenSource({}, { run: f.run, env: {} });
    expect((await readError(src)).message).toMatch(/BWS_ACCESS_TOKEN/);
    expect(f.calls).toHaveLength(0);
  });
});
