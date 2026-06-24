import { describe, expect, test } from "bun:test";
import { buildSource } from "../../../src/commands/secrets";
import type { CommandResult } from "../../../src/secrets/sources/exec";

const noopRun = (): Promise<CommandResult> => Promise.resolve({ code: 0, stdout: "[]", stderr: "" });

describe("buildSource", () => {
  test("dispatches --from bitwarden to the Bitwarden adapter", () => {
    const src = buildSource(
      { from: "bitwarden", project: "prod", bwsProject: "x" },
      { run: noopRun, env: { BWS_ACCESS_TOKEN: "t" } },
    );
    expect(src.name).toBe("bitwarden");
  });

  test("throws on an unknown source", () => {
    expect(() =>
      buildSource({ from: "lastpass", project: "prod" }, { run: noopRun, env: {} }),
    ).toThrow(/unknown import source: lastpass.*bitwarden/s);
  });
});
