// cli/tests/unit/commands/secrets-inject.test.ts
import { describe, expect, test } from "bun:test";
import { assertOutputWritable, usesMachineLane } from "../../../src/commands/secrets";
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

// Fix round 1 (finding 1): the resolver-selection branch at inject's action
// site had zero coverage — reverting `ctx.tokenType !== "tenant"` back to
// `ctx.tokenType === "automation"` passed the full 114-file gate with zero
// failures. Extracted so the branch condition itself is testable, mirroring
// assertMachineCredential in run.ts.
describe("usesMachineLane", () => {
  test("a machine token uses the machine lane", () => {
    expect(usesMachineLane("machine")).toBe(true);
  });
  test("an automation key uses the machine lane", () => {
    expect(usesMachineLane("automation")).toBe(true);
  });
  test("a tenant (interactive OAuth) session does not use the machine lane", () => {
    expect(usesMachineLane("tenant")).toBe(false);
  });
});
