import { describe, expect, test } from "bun:test";
import { reinvokeArgv } from "../../../src/completion/refresh";

describe("reinvokeArgv", () => {
  test("compiled-binary form: argv0 only, no script arg", () => {
    expect(reinvokeArgv(["/usr/local/bin/reoclo", "apps", "ls"])).toEqual([
      "/usr/local/bin/reoclo",
      ["__refresh-completion"],
    ]);
  });

  test("runtime form: keeps the script path", () => {
    expect(reinvokeArgv(["/usr/bin/bun", "/repo/src/index.ts", "apps", "ls"])).toEqual([
      "/usr/bin/bun",
      ["/repo/src/index.ts", "__refresh-completion"],
    ]);
  });
});
