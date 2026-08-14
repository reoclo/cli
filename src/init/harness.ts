// src/init/harness.ts
//
// Pure harness detection + destination mapping for skill installation. A "skill"
// is a portable SKILL.md dir; almost every harness reads it from the cross-client
// `.agents/skills/` directory, so installation is placement, not conversion. Only
// Claude Code needs a symlink (it reads `.claude/skills/` only). `AGENTS.md`
// pointers are held in reserve for a future always-on-only harness.
import { join } from "node:path";

export type HarnessId = "claude" | "opencode" | "codex" | "gemini" | "cursor";
export type Scope = "project" | "global";

export interface Probes {
  exists: (path: string) => boolean;
  which: (bin: string) => boolean;
}

export interface DetectedHarness {
  id: HarnessId;
  label: string;
  present: boolean;
}

export interface Placement {
  /** Where SKILL.md dirs are physically written (`.agents/skills`). */
  canonicalRoot: string;
  /** `<root>/.claude/skills` dirs to symlink to the canonical store. */
  symlinkDirs: string[];
  /** `AGENTS.md` files to append a pointer line to (empty for the v1 harness set). */
  pointerFiles: string[];
}

type Kind = "claude-symlink" | "agents-dir" | "agents-pointer";

interface HarnessSpec {
  id: HarnessId;
  label: string;
  bin: string;
  /** dir names probed under cwd (project) and home (global) to detect presence. */
  marker: string;
  kind: Kind;
}

export const HARNESSES: readonly HarnessSpec[] = [
  { id: "claude", label: "Claude Code", bin: "claude", marker: ".claude", kind: "claude-symlink" },
  { id: "opencode", label: "opencode", bin: "opencode", marker: ".opencode", kind: "agents-dir" },
  { id: "codex", label: "Codex", bin: "codex", marker: ".codex", kind: "agents-dir" },
  { id: "gemini", label: "Gemini CLI", bin: "gemini", marker: ".gemini", kind: "agents-dir" },
  { id: "cursor", label: "Cursor", bin: "cursor", marker: ".cursor", kind: "agents-dir" },
];

export function detectHarnesses(cwd: string, home: string, probes: Probes): DetectedHarness[] {
  return HARNESSES.map((h) => ({
    id: h.id,
    label: h.label,
    present:
      probes.which(h.bin) ||
      probes.exists(join(cwd, h.marker)) ||
      probes.exists(join(home, h.marker)),
  }));
}

export function destinationsFor(
  selection: HarnessId[],
  scope: Scope,
  cwd: string,
  home: string,
): Placement {
  const base = scope === "project" ? cwd : home;
  const canonicalRoot = join(base, ".agents", "skills");
  const picked = new Set(selection);
  const symlinkDirs: string[] = [];
  const pointerFiles: string[] = [];
  for (const h of HARNESSES) {
    if (!picked.has(h.id)) continue;
    if (h.kind === "claude-symlink") symlinkDirs.push(join(base, ".claude", "skills"));
    else if (h.kind === "agents-pointer") pointerFiles.push(join(base, "AGENTS.md"));
  }
  return { canonicalRoot, symlinkDirs, pointerFiles };
}
