import { describe, expect, test } from "bun:test";
import { deriveKey, uniqueKey, mapItemFields } from "../../../src/secrets/sources/onepassword";
import type { OpItem } from "../../../src/secrets/sources/onepassword";
import { onepasswordSource } from "../../../src/secrets/sources/onepassword";
import type { CommandResult } from "../../../src/secrets/sources/exec";
import type { SecretSource } from "../../../src/secrets/types";

describe("deriveKey", () => {
  test("joins title + label as UPPER_SNAKE", () => {
    expect(deriveKey("My DB", "Connection String")).toBe("MY_DB_CONNECTION_STRING");
  });
  test("collapses runs of non-alphanumerics and strips edges", () => {
    expect(deriveKey("  api / key  ", "")).toBe("API_KEY");
  });
  test("falls back to SECRET when empty", () => {
    expect(deriveKey("", "")).toBe("SECRET");
  });
});

describe("uniqueKey", () => {
  test("suffixes collisions and records each result", () => {
    const used = new Set<string>();
    expect(uniqueKey("K", used)).toBe("K");
    expect(uniqueKey("K", used)).toBe("K_2");
    expect(uniqueKey("K", used)).toBe("K_3");
    expect(used.has("K_3")).toBe(true);
  });
});

describe("mapItemFields", () => {
  test("keeps concealed/text/url; drops OTP, NOTES, empty; keys by title+label", () => {
    const item: OpItem = {
      title: "Prod DB",
      fields: [
        { type: "STRING", purpose: "USERNAME", label: "username", value: "admin" },
        { type: "CONCEALED", purpose: "PASSWORD", label: "password", value: "p@ss" },
        { type: "URL", label: "host", value: "db.example.com" },
        { type: "OTP", label: "one-time password", value: "123456" },
        { type: "STRING", purpose: "NOTES", label: "notesPlain", value: "free text" },
        { type: "STRING", label: "empty", value: "" },
      ],
    };
    expect(mapItemFields(item, new Set<string>())).toEqual([
      { key: "PROD_DB_USERNAME", value: "admin", note: null },
      { key: "PROD_DB_PASSWORD", value: "p@ss", note: null },
      { key: "PROD_DB_HOST", value: "db.example.com", note: null },
    ]);
  });

  test("de-collides keys across items via a shared used-set", () => {
    const used = new Set<string>();
    const a = mapItemFields(
      { title: "AWS", fields: [{ type: "CONCEALED", label: "key", value: "v1" }] },
      used,
    );
    const b = mapItemFields(
      { title: "AWS", fields: [{ type: "CONCEALED", label: "key", value: "v2" }] },
      used,
    );
    expect(a[0]!.key).toBe("AWS_KEY");
    expect(b[0]!.key).toBe("AWS_KEY_2");
  });

  test("ignores non-string field values defensively", () => {
    const item = { title: "X", fields: [{ type: "STRING", label: "n", value: 5 }] } as unknown as OpItem;
    expect(mapItemFields(item, new Set<string>())).toEqual([]);
  });
});

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });

/** Fake runner for `op`: cmd[2] selects list/get; get is keyed by item id (cmd[3]). */
function fakeOp(h: { list: CommandResult; get?: Record<string, CommandResult> }): {
  run: (cmd: string[]) => Promise<CommandResult>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: (cmd: string[]): Promise<CommandResult> => {
      calls.push(cmd);
      const sub = cmd[2] ?? "";
      if (sub === "list") return Promise.resolve(h.list);
      if (sub === "get") {
        const r = (h.get ?? {})[cmd[3] ?? ""];
        if (!r) return Promise.reject(new Error(`unexpected op get: ${cmd[3]}`));
        return Promise.resolve(r);
      }
      return Promise.reject(new Error(`unexpected op call: ${cmd.join(" ")}`));
    },
  };
}

/** Invoke read() and return the Error it rejects with (repo lint forbids
 *  `.rejects.toThrow()`). */
async function readError(src: SecretSource): Promise<Error> {
  try {
    await src.read();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected read() to reject, but it resolved");
}

const ITEM_GET = JSON.stringify({
  title: "Prod DB",
  vault: { id: "v1" },
  fields: [
    { type: "CONCEALED", purpose: "PASSWORD", label: "password", value: "p@ss" },
    { type: "OTP", label: "one-time password", value: "123456" },
  ],
});

describe("onepasswordSource.read", () => {
  test("lists items, fetches each with its vault id, normalizes + filters", async () => {
    const f = fakeOp({
      list: ok(JSON.stringify([{ id: "i1", vault: { id: "v1" } }])),
      get: { i1: ok(ITEM_GET) },
    });
    const out = await onepasswordSource({}, { run: f.run, env: {} }).read();
    expect(out).toEqual([{ key: "PROD_DB_PASSWORD", value: "p@ss", note: null }]);
    expect(f.calls[0]).toEqual(["op", "item", "list", "--format", "json"]);
    expect(f.calls[1]).toEqual(["op", "item", "get", "i1", "--vault", "v1", "--format", "json"]);
  });

  test("empty item list returns [] and makes no get calls", async () => {
    const f = fakeOp({ list: ok("[]") });
    const out = await onepasswordSource({}, { run: f.run, env: {} }).read();
    expect(out).toEqual([]);
    expect(f.calls).toHaveLength(1);
  });

  test("--op-vault is passed through to op item list", async () => {
    const f = fakeOp({ list: ok("[]") });
    await onepasswordSource({ opVault: "Dev" }, { run: f.run, env: {} }).read();
    expect(f.calls[0]).toEqual(["op", "item", "list", "--vault", "Dev", "--format", "json"]);
  });

  test("de-collides keys across items", async () => {
    const item = (v: string): string =>
      JSON.stringify({ title: "AWS", vault: { id: "v1" }, fields: [{ type: "CONCEALED", label: "key", value: v }] });
    const f = fakeOp({
      list: ok(JSON.stringify([{ id: "a", vault: { id: "v1" } }, { id: "b", vault: { id: "v1" } }])),
      get: { a: ok(item("v1")), b: ok(item("v2")) },
    });
    const out = await onepasswordSource({}, { run: f.run, env: {} }).read();
    expect(out.map((s) => s.key)).toEqual(["AWS_KEY", "AWS_KEY_2"]);
  });

  test("missing op binary (ENOENT) throws an install hint", async () => {
    const run = (): Promise<CommandResult> =>
      Promise.reject(Object.assign(new Error("spawn op ENOENT"), { code: "ENOENT" }));
    const src = onepasswordSource({}, { run, env: {} });
    expect((await readError(src)).message).toMatch(/op.*not found|install/i);
  });

  test("non-zero exit surfaces op stderr (e.g. not signed in)", async () => {
    const f = fakeOp({ list: { code: 1, stdout: "", stderr: "[ERROR] you are not currently signed in" } });
    const src = onepasswordSource({}, { run: f.run, env: {} });
    const err = await readError(src);
    expect(err.message).toMatch(/op item list failed/);
    expect(err.message).toMatch(/not currently signed in/);
  });

  test("non-zero get exit never leaks secret values from stdout", async () => {
    const f = fakeOp({
      list: ok(JSON.stringify([{ id: "i1", vault: { id: "v1" } }])),
      get: { i1: { code: 1, stdout: JSON.stringify({ fields: [{ value: "sup3r-s3cret" }] }), stderr: "boom" } },
    });
    const err = await readError(onepasswordSource({}, { run: f.run, env: {} }));
    expect(err.message).not.toContain("sup3r-s3cret");
    expect(err.message).toMatch(/op item get failed/);
  });

  test("non-JSON list stdout throws a guarded parse error", async () => {
    const f = fakeOp({ list: ok("not json at all") });
    const src = onepasswordSource({}, { run: f.run, env: {} });
    expect((await readError(src)).message).toMatch(/could not parse/i);
  });
});
