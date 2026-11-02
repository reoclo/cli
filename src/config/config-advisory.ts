// src/config/config-advisory.ts
import { projectConfigOutdated, type ProjectConfig } from "./project-config";

function throttled(notifiedAt: string | undefined, now: number, throttleMs: number): boolean {
  if (!notifiedAt) return false;
  const t = Date.parse(notifiedAt);
  if (Number.isNaN(t)) return false;
  return now - t < throttleMs;
}

/** Pure advisory composition for a bound project (a present `.reoclo`). Emits at
 *  most one throttled line for an outdated project config. Returns the updated
 *  notified-at stamp when it fired. Skills have no advisory: the MCP server
 *  serves them, so there are no project copies for `init` to refresh. */
export function configAdvisories(deps: {
  projectConfig: ProjectConfig | null;
  now: number;
  throttleMs: number;
  configNotifiedAt?: string;
}): { lines: string[]; configNotifiedAt?: string } {
  const lines: string[] = [];
  let configNotifiedAt = deps.configNotifiedAt;
  if (!deps.projectConfig) return { lines, configNotifiedAt };

  if (projectConfigOutdated(deps.projectConfig) && !throttled(deps.configNotifiedAt, deps.now, deps.throttleMs)) {
    lines.push("reoclo project config is out of date. Run 'reoclo init' to update.");
    configNotifiedAt = new Date(deps.now).toISOString();
  }
  return { lines, configNotifiedAt };
}
