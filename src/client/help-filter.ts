import type { Command } from "commander";
import { getRequiredCapability } from "./command-meta";

/** Walk the command tree and hide any tagged command whose capability isn't granted. */
export function filterCommandsByCapability(
  root: Command,
  capabilities: string[] | undefined,
): void {
  for (const child of root.commands) {
    const verb = getRequiredCapability(child);
    if (verb !== null && (!capabilities || !capabilities.includes(verb))) {
      // Hide from --help output. Commander 12+ exposes a public API, but
      // setting the private _hidden field works back to v8 too.
      (child as unknown as { _hidden: boolean })._hidden = true;
    }
    filterCommandsByCapability(child, capabilities);
  }
}
