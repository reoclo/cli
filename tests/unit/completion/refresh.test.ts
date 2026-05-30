import { describe, expect, test } from "bun:test";
import { reinvokeArgv } from "../../../src/completion/refresh";

describe("reinvokeArgv", () => {
  test("compiled-binary form: re-spawns the binary via execPath, no script arg", () => {
    // In a `bun build --compile` binary, process.argv[0] is the literal "bun"
    // (a Bun quirk), the real executable path lands in argv[1], and
    // process.execPath points at the standalone binary.
    expect(
      reinvokeArgv(["bun", "/usr/local/bin/reoclo", "apps", "ls"], "/usr/local/bin/reoclo"),
    ).toEqual(["/usr/local/bin/reoclo", ["__refresh-completion"]]);
  });

  test("compiled-binary form: never re-spawns 'bun' from argv[0]", () => {
    // Regression: previously used argv[0] ("bun") as the executable, which
    // failed with ENOENT on machines without Bun installed.
    const [exe] = reinvokeArgv(["bun", "/usr/local/bin/reoclo", "whoami"], "/usr/local/bin/reoclo");
    expect(exe).not.toBe("bun");
  });

  test("runtime form: keeps the script path when the runtime is bun", () => {
    expect(
      reinvokeArgv(["/usr/bin/bun", "/repo/src/index.ts", "apps", "ls"], "/usr/bin/bun"),
    ).toEqual(["/usr/bin/bun", ["/repo/src/index.ts", "__refresh-completion"]]);
  });
});
