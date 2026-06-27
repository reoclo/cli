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

  test("dispatches --from onepassword to the 1Password adapter", () => {
    const src = buildSource(
      { from: "onepassword", project: "prod", opVault: "Dev" },
      { run: noopRun, env: { OP_SERVICE_ACCOUNT_TOKEN: "t" } },
    );
    expect(src.name).toBe("onepassword");
  });

  test("throws on an unknown source, listing supported sources", () => {
    expect(() =>
      buildSource({ from: "lastpass", project: "prod" }, { run: noopRun, env: {} }),
    ).toThrow(/unknown import source: lastpass.*bitwarden.*onepassword/s);
  });
});
