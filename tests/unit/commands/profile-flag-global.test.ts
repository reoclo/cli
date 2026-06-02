// tests/unit/commands/profile-flag-global.test.ts
//
// `--profile` is a single ROOT-level (global) option (declared in index.ts).
// Any command that ALSO declares a command-local `--profile` re-introduces the
// global-vs-local collision: commander routes the typed value to the global
// option and the local one keeps its default (or undefined), so the command
// silently acts on the wrong profile. This structural guard fails if any
// command re-declares `--profile`.

import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerLogin } from "../../../src/commands/login";
import { registerLogout } from "../../../src/commands/logout";
import { registerKeyring } from "../../../src/commands/keyring";
import { registerMcp } from "../../../src/commands/mcp";
import { registerCompletion } from "../../../src/commands/completion";

function collectLocalProfileOptions(cmd: Command, path: string, out: string[]): void {
  for (const sub of cmd.commands) {
    const subPath = `${path} ${sub.name()}`.trim();
    if (sub.options.some((o) => o.long === "--profile")) out.push(subPath);
    collectLocalProfileOptions(sub, subPath, out);
  }
}

const REGISTRARS: ReadonlyArray<readonly [string, (p: Command) => void]> = [
  ["login", registerLogin],
  ["logout", registerLogout],
  ["keyring", registerKeyring],
  ["mcp", registerMcp],
  ["completion", registerCompletion],
];

describe("--profile is global-only — no command re-declares it", () => {
  for (const [name, register] of REGISTRARS) {
    test(`${name} declares no command-local --profile option`, () => {
      const program = new Command();
      program.option("--profile <name>", "use a named profile");
      register(program);
      const offenders: string[] = [];
      collectLocalProfileOptions(program, "", offenders);
      expect(offenders).toEqual([]);
    });
  }
});
