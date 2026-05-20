import type { Command } from "commander";
import { getRequiredCapability } from "./command-meta";

/** Walk the command tree and hide any tagged command whose capability isn't granted.
 *  When `capabilities` is missing or empty we treat that as "unknown" and show
 *  every command — the server enforces capabilities anyway, and hiding the
 *  whole CLI surface when the local cache isn't populated (e.g. /auth/me/
 *  capabilities returned 404, or this is an OAuth profile that never fetched)
 *  is worse UX than letting the user discover the command and get a clear
 *  error from the server. */
export function filterCommandsByCapability(
  root: Command,
  capabilities: string[] | undefined,
): void {
  if (!capabilities || capabilities.length === 0) return;
  for (const child of root.commands) {
    const verb = getRequiredCapability(child);
    if (verb !== null && !capabilities.includes(verb)) {
      // Hide from --help output. Commander 12+ exposes a public API, but
      // setting the private _hidden field works back to v8 too.
      (child as unknown as { _hidden: boolean })._hidden = true;
    }
    filterCommandsByCapability(child, capabilities);
  }
}
