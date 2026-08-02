// src/config/config-advisory.ts
import { projectConfigOutdated, type ProjectConfig } from "./project-config";

function throttled(notifiedAt: string | undefined, now: number, throttleMs: number): boolean {
  if (!notifiedAt) return false;
  const t = Date.parse(notifiedAt);
  if (Number.isNaN(t)) return false;
  return now - t < throttleMs;
}

/** Pure advisory composition for a bound project (a present `.reoclo`). Emits at
 *  most one line each for an outdated project config and for stale skills, each
 *  throttled independently. Returns updated notified-at stamps for whatever fired. */
export function configAdvisories(deps: {
  projectConfig: ProjectConfig | null;
  latestSkillsSha: string | undefined;
  now: number;
  throttleMs: number;
  configNotifiedAt?: string;
  skillsNotifiedAt?: string;
}): { lines: string[]; configNotifiedAt?: string; skillsNotifiedAt?: string } {
  const lines: string[] = [];
  let configNotifiedAt = deps.configNotifiedAt;
  let skillsNotifiedAt = deps.skillsNotifiedAt;
  if (!deps.projectConfig) return { lines, configNotifiedAt, skillsNotifiedAt };
  const nowIso = new Date(deps.now).toISOString();

  if (projectConfigOutdated(deps.projectConfig) && !throttled(deps.configNotifiedAt, deps.now, deps.throttleMs)) {
    lines.push("reoclo project config is out of date. Run 'reoclo init' to update.");
    configNotifiedAt = nowIso;
  }

  const installed = deps.projectConfig.skills?.sha;
  if (
    installed && deps.latestSkillsSha && installed !== deps.latestSkillsSha &&
    !throttled(deps.skillsNotifiedAt, deps.now, deps.throttleMs)
  ) {
    lines.push("reoclo skills update available. Run 'reoclo init' to update your skills.");
    skillsNotifiedAt = nowIso;
  }
  return { lines, configNotifiedAt, skillsNotifiedAt };
}
