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
import type { Placement } from "./harness";

const REPO = "reoclo/skills";

const PORTABLE_KEYS = new Set([
  "name", "description", "license", "compatibility", "metadata", "allowed-tools",
]);

/** Rewrite a SKILL.md's YAML frontmatter to the six portable Agent Skills fields,
 *  dropping vendor extensions that hard-fail validation on non-Claude clients. A
 *  file with no frontmatter fence is returned unchanged.
 *
 *  Line-oriented on purpose: it keeps each portable top-level `key:` line (plus
 *  any of its indented continuation / block-scalar lines) VERBATIM, and drops
 *  every line belonging to a non-portable key. Nothing is parsed or re-emitted
 *  through js-yaml, so values survive byte-for-byte. That matters because a real
 *  `description` is an unquoted plain scalar with a bare "colon-space" (e.g.
 *  "(or its `rc` alias): signing in") — valid to Claude Code / the Agent Skills
 *  spec, but something `js-yaml.load` rejects as a nested mapping key. A
 *  round-trip would throw there, or silently re-quote/reflow the value. */
export function toPortableFrontmatter(skillMd: string): string {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(skillMd);
  if (!m) return skillMd;
  const body = skillMd.slice(m[0].length);

  // A top-level key is at column 0: no leading whitespace, an unquoted key, then
  // a colon that is followed by whitespace or the end of the line (YAML's own
  // mapping rule). Any other line (indented, blank, block-scalar text) belongs
  // to the top-level key that opened above it.
  const topKey = /^([A-Za-z0-9_-]+):(?:\s|$)/;
  const kept: string[] = [];
  let keeping = false;
  for (const line of (m[1] ?? "").split("\n")) {
    const key = topKey.exec(line);
    if (key) keeping = PORTABLE_KEYS.has(key[1] ?? "");
    if (keeping) kept.push(line);
  }
  return `---\n${kept.join("\n")}\n---\n${body}`;
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

export interface AvailableSkills {
  /** Skill dir names (any child with a SKILL.md), sorted. */
  available: string[];
  /** Extracted tarball root — each `available` name is a dir directly under it. */
  sourceRoot: string;
  /** Remove the temp download/extract dir. Always call when done with `sourceRoot`. */
  cleanup: () => void;
}

/**
 * Download the skills tarball and extract it to a temp dir, returning the
 * available skill names (dirs containing SKILL.md). Shared by `installSkills`
 * (which selects + places a subset, then cleans up) and `reoclo skills list`
 * (which only needs the names). Throws a clear, actionable error when the
 * download fails or `tar` is unavailable — same errors `installSkills` has
 * always thrown for these cases.
 */
export async function fetchAvailableSkills(opts: {
  ref?: string;
  fetchImpl?: typeof fetch;
}): Promise<AvailableSkills> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = skillsTarballUrl(opts.ref ?? "main");
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`failed to download skills (HTTP ${res.status} from ${url})`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());

  const work = mkdtempSync(join(tmpdir(), "reoclo-skills-"));
  const cleanup = () => rmSync(work, { recursive: true, force: true });
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

    return { available, sourceRoot: root, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
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
 * Download the skills tarball, extract it, and place each selected skill dir
 * via `placeSkills` (canonical `.agents/skills` copy + portable frontmatter +
 * Claude symlinks/pointers, per the resolved `placement`). Idempotent —
 * re-running refreshes skills in place. Throws a clear, actionable error when
 * the download fails or `tar` is unavailable. `fetchImpl` is injectable for
 * tests.
 */
export async function installSkills(opts: {
  placement: Placement;
  requested?: string[];
  ref?: string;
  fetchImpl?: typeof fetch;
}): Promise<InstallSkillsResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { available, sourceRoot, cleanup } = await fetchAvailableSkills({
    ref: opts.ref,
    fetchImpl,
  });
  try {
    const { selected, missing } = selectSkills(available, opts.requested);
    placeSkills({ sourceRoot, selected, placement: opts.placement });
    const sha = (await resolveSkillsHead(opts.ref ?? "main", fetchImpl)) ?? undefined;
    return { installed: selected, missing, sha };
  } finally {
    cleanup();
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
