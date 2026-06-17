// src/init/skills.ts
//
// Helpers for `reoclo init`'s skill download. The reoclo agent skills live in
// the public, flat github.com/reoclo/skills repo (one `<name>/SKILL.md` dir per
// skill). selectSkills/skillsTarballUrl are pure; installSkills is the
// imperative shell (fetch tarball → `tar` extract → copy into .claude/skills).

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "reoclo/skills";

/** The codeload tarball URL for a branch ref (default: main). */
export function skillsTarballUrl(ref = "main"): string {
  return `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${ref}`;
}

export interface InstallSkillsResult {
  installed: string[];
  missing: string[];
}

/**
 * Download the skills tarball, extract it, and copy each selected skill dir into
 * `destDir` (a project's `.claude/skills`). Idempotent — re-running refreshes
 * skills in place. Throws a clear, actionable error when the download fails or
 * `tar` is unavailable. `fetchImpl` is injectable for tests.
 */
export async function installSkills(opts: {
  destDir: string;
  requested?: string[];
  ref?: string;
  fetchImpl?: typeof fetch;
}): Promise<InstallSkillsResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = skillsTarballUrl(opts.ref ?? "main");
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`failed to download skills (HTTP ${res.status} from ${url})`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());

  const work = mkdtempSync(join(tmpdir(), "reoclo-skills-"));
  try {
    const tarball = join(work, "skills.tar.gz");
    writeFileSync(tarball, bytes);
    const extractDir = join(work, "extracted");
    mkdirSync(extractDir, { recursive: true });

    const tar = spawnSync("tar", ["-xzf", tarball, "-C", extractDir], { stdio: "ignore" });
    if (tar.error) {
      throw new Error(
        "could not run 'tar' to extract skills — install tar, or clone manually:\n" +
          "  git clone https://github.com/reoclo/skills.git ~/.claude/skills",
      );
    }
    if (tar.status !== 0) throw new Error("failed to extract the skills archive");

    // codeload wraps everything in a single top-level dir (skills-<ref>/).
    const tops = readdirSync(extractDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    const root = tops[0] ? join(extractDir, tops[0].name) : extractDir;

    // A skill is any child dir that contains a SKILL.md.
    const available = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "SKILL.md")))
      .map((d) => d.name)
      .sort();

    const { selected, missing } = selectSkills(available, opts.requested);
    mkdirSync(opts.destDir, { recursive: true });
    for (const name of selected) {
      cpSync(join(root, name), join(opts.destDir, name), { recursive: true });
    }
    return { installed: selected, missing };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Decide which skills to install. With no (or an empty) request, selects every
 * available skill. Otherwise selects the requested subset — in available order
 * — and reports any requested names that don't exist so the caller can warn
 * instead of silently skipping. Requested names are trimmed and de-duplicated.
 */
export function selectSkills(
  available: string[],
  requested?: string[],
): { selected: string[]; missing: string[] } {
  const want = (requested ?? []).map((s) => s.trim()).filter((s) => s !== "");
  if (want.length === 0) return { selected: [...available], missing: [] };

  const availableSet = new Set(available);
  const seen = new Set<string>();
  const selected: string[] = [];
  const missing: string[] = [];
  for (const name of want) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!availableSet.has(name)) missing.push(name);
  }
  // Keep `selected` in available order for stable output.
  for (const name of available) {
    if (seen.has(name)) selected.push(name);
  }
  return { selected, missing };
}
