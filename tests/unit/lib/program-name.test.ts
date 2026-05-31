import { describe, expect, test } from "bun:test";
import { detectProgramName } from "../../../src/lib/program-name";

describe("detectProgramName", () => {
  test("resolves the rc alias from a bare name", () => {
    expect(detectProgramName("rc")).toBe("rc");
  });

  test("resolves the rc alias from a relative path", () => {
    expect(detectProgramName("./rc")).toBe("rc");
  });

  test("resolves the rc alias from an absolute path", () => {
    expect(detectProgramName("/usr/local/bin/rc")).toBe("rc");
  });

  test("strips a .exe suffix and matches case-insensitively", () => {
    // Bare names only: node:path.basename is POSIX in the test env and does
    // not split on backslashes, so Windows drive paths can't be asserted here.
    expect(detectProgramName("RC.exe")).toBe("rc");
    expect(detectProgramName("reoclo.exe")).toBe("reoclo");
  });

  test("resolves to reoclo for the canonical name", () => {
    expect(detectProgramName("/usr/local/bin/reoclo")).toBe("reoclo");
  });

  test("resolves to reoclo for the dev/runtime argv0 (bun)", () => {
    // Regression: the compiled binary used to read process.argv[0], which Bun
    // sets to the literal "bun" — masking the rc alias. The real invocation
    // lives in process.argv0; "bun" itself must resolve to reoclo.
    expect(detectProgramName("/Users/x/.bun/bin/bun")).toBe("reoclo");
    expect(detectProgramName("bun")).toBe("reoclo");
  });

  test("resolves to reoclo for an empty argv0", () => {
    expect(detectProgramName("")).toBe("reoclo");
  });
});
