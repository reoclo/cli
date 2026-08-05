// cli/tests/unit/commands/secrets-inject.test.ts
import { describe, expect, test } from "bun:test";
import { assertOutputWritable } from "../../../src/commands/secrets";
import { EXIT } from "../../../src/client/exit-codes";

describe("assertOutputWritable", () => {
  test("throws MISUSE when the file exists and --force is absent", () => {
    let err: unknown;
    try { assertOutputWritable(true, false, "/tmp/.env"); } catch (e) { err = e; }
    expect((err as { exitCode: number }).exitCode).toBe(EXIT.MISUSE);
    expect((err as Error).message).toContain("--force");
  });
  test("allows an existing file when --force is set", () => {
    expect(() => assertOutputWritable(true, true, "/tmp/.env")).not.toThrow();
  });
  test("allows a non-existent file", () => {
    expect(() => assertOutputWritable(false, false, "/tmp/.env")).not.toThrow();
  });
});
