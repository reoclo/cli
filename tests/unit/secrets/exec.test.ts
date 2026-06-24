import { describe, expect, test } from "bun:test";
import { runCommand } from "../../../src/secrets/sources/exec";

describe("runCommand", () => {
  test("captures stdout, stderr, and exit code", async () => {
    const r = await runCommand(["sh", "-c", "printf out; printf err >&2; exit 3"]);
    expect(r.stdout).toBe("out");
    expect(r.stderr).toBe("err");
    expect(r.code).toBe(3);
  });

  test("passes the provided env to the child", async () => {
    const r = await runCommand(["sh", "-c", "printf %s \"$FOO\""], {
      env: { ...process.env, FOO: "bar" },
    });
    expect(r.stdout).toBe("bar");
    expect(r.code).toBe(0);
  });

  test("throws with code ENOENT when the binary is missing", async () => {
    let err: unknown;
    try {
      await runCommand(["reoclo-nonexistent-binary-xyz"]);
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe("ENOENT");
  });
});
