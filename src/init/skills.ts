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
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, dump } from "js-yaml";
import type { Placement } from "./harness";

const REPO = "reoclo/skills";

const PORTABLE_KEYS = new Set([
  "name", "description", "license", "compatibility", "metadata", "allowed-tools",
]);

/** Rewrite a SKILL.md's YAML frontmatter to the six portable Agent Skills fields,
 *  dropping vendor extensions that hard-fail validation on non-Claude clients. A
 *  file with no frontmatter fence is returned unchanged. */
export function toPortableFrontmatter(skillMd: string): string {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(skillMd);
  if (!m) return skillMd;
  const parsed = (load(m[1] ?? "") ?? {}) as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (PORTABLE_KEYS.has(k)) kept[k] = v;
  }
  const body = skillMd.slice(m[0].length);
  const yaml = dump(kept, { lineWidth: -1 }).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

export interface PlaceFs {
  isWindows: boolean;
  mkdir: (path: string) => void;
  cpDir: (from: string, to: string) => void;
  readFile: (path: string) => string;
  writeFile: (path: string, contents: string) => void;
  symlink: (target: string, linkPath: string) => void;
}

const defaultPlaceFs: PlaceFs = {
  isWindows: process.platform === "win32",
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  cpDir: (from, to) => { rmSync(to, { recursive: true, force: true }); cpSync(from, to, { recursive: true }); },
  readFile: (p) => readFileSync(p, "utf8"),
  writeFile: (p, c) => writeFileSync(p, c),
  symlink: (target, linkPath) => { rmSync(linkPath, { recursive: true, force: true }); symlinkSync(target, linkPath); },
};

/**
 * Physically place already-extracted skill dirs. Each selected skill is copied
 * into `placement.canonicalRoot` with portable frontmatter, then Claude symlink
 * dirs are linked to the canonical copy (a real copy on Windows, or if symlink
 * throws), and any pointer files get a one-line reference appended.
 */
export function placeSkills(opts: {
  sourceRoot: string;
  selected: string[];
  placement: Placement;
  fsImpl?: PlaceFs;
}): void {
  const fs = opts.fsImpl ?? defaultPlaceFs;
  const { canonicalRoot, symlinkDirs, pointerFiles } = opts.placement;
  fs.mkdir(canonicalRoot);
  for (const name of opts.selected) {
    const dst = join(canonicalRoot, name);
    fs.cpDir(join(opts.sourceRoot, name), dst);
    const skillMd = join(dst, "SKILL.md");
    fs.writeFile(skillMd, toPortableFrontmatter(fs.readFile(skillMd)));
  }
  for (const linkRoot of symlinkDirs) {
    fs.mkdir(linkRoot);
    for (const name of opts.selected) {
      const link = join(linkRoot, name);
      const target = join(canonicalRoot, name);
      if (fs.isWindows) { fs.cpDir(target, link); continue; }
      try { fs.symlink(target, link); } catch { fs.cpDir(target, link); }
    }
  }
  for (const agentsMd of pointerFiles) {
    const line = opts.selected.map((n) => `See \`.agents/skills/${n}/\` for the ${n} skill.`).join("\n");
    fs.writeFile(agentsMd, `${line}\n`);
  }
}

/** The codeload tarball URL for a branch ref (default: main). */
export function skillsTarballUrl(ref = "main"): string {
  return `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${ref}`;
}

export interface InstallSkillsResult {
  installed: string[];
  missing: string[];
  sha?: string;
}

/** Best-effort: resolve the skills repo branch head commit SHA via the public
 *  GitHub API. Returns null on any non-ok/parse/network outcome (rate-limit
 *  tolerant — unauthenticated 60/hr) so callers never fail on it. */
export async function resolveSkillsHead(ref = "main", fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${REPO}/commits/${ref}`, {
      headers: { Accept: "application/vnd.github.sha" },
    });
    if (!res.ok) return null;
    const body = (await res.text()).trim();
    // Accept either a raw sha (vnd.github.sha) or a JSON commit object.
    if (/^[0-9a-f]{7,40}$/i.test(body)) return body;
    try {
      const j = JSON.parse(body) as { sha?: string };
      return j.sha ?? null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Download the skills tarball, extract it, and place each selected skill dir.
 * When `placement` is given, skills are placed via `placeSkills` (canonical
 * `.agents/skills` copy + portable frontmatter + Claude symlinks/pointers).
 * Otherwise, falls back to copying into `destDir` (a project's
 * `.claude/skills`) unchanged, for callers not yet migrated to `placement`.
 * Idempotent — re-running refreshes skills in place. Throws a clear,
 * actionable error when the download fails or `tar` is unavailable.
 * `fetchImpl` is injectable for tests.
 */
export async function installSkills(opts: {
  destDir?: string;
  placement?: Placement;
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
    if (opts.placement) {
      placeSkills({ sourceRoot: root, selected, placement: opts.placement });
    } else if (opts.destDir) {
      mkdirSync(opts.destDir, { recursive: true });
      for (const name of selected) {
        cpSync(join(root, name), join(opts.destDir, name), { recursive: true });
      }
    } else {
      throw new Error("installSkills requires either `placement` or `destDir`");
    }
    const sha = (await resolveSkillsHead(opts.ref ?? "main", fetchImpl)) ?? undefined;
    return { installed: selected, missing, sha };
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
