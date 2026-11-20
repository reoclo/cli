// src/agents/command-path.ts
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { AgentConfigError } from "./errors";

export interface InvokedCommandInput {
  /** Value of --command, when given. */
  readonly override: string | undefined;
  /** process.argv0: the name the user invoked the CLI by. */
  readonly argv0: string;
  readonly cwd: string;
  /** Finds a bare command name on PATH. */
  readonly which: (name: string) => string | null;
}

const CLI_NAMES = new Set(["reoclo", "rc"]);

/**
 * The path an agent should run. It is the path the user invoked reoclo by, not
 * its resolved symlink target, so ~/.local/bin/reoclo stays valid when the
 * binary behind it moves or updates.
 */
export function resolveServerCommand({ override, argv0, cwd, which }: InvokedCommandInput): string {
  if (override !== undefined) {
    const path = resolve(cwd, override);
    if (!existsSync(path)) throw new AgentConfigError("invalid-command", `--command ${path} does not exist`);
    return path;
  }
  const name = basename(argv0).toLowerCase().replace(/\.exe$/, "");
  if (!CLI_NAMES.has(name)) {
    throw new AgentConfigError("invalid-command", `cannot tell where reoclo is installed (this process started as ${argv0}); pass --command <path>`);
  }
  if (argv0.includes("/")) return resolve(cwd, argv0);
  const found = which(argv0);
  if (found === null) throw new AgentConfigError("invalid-command", `${argv0} is not on PATH; pass --command <path>`);
  return resolve(cwd, found);
}
