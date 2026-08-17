import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listInstalledSkills, runSkillsUpdate } from "../../../src/init/update";

/** Build a codeload-style tarball (single top-level `skills-main/` dir) holding
 *  the given skills, and return its bytes. */
function buildSkillsTarball(skills: { name: string; body: string }[]): Buffer {
  const work = mkdtempSync(join(tmpdir(), "update-fixture-"));
  const root = join(work, "skills-main");
  for (const s of skills) {
    mkdirSync(join(root, s.name), { recursive: true });
    writeFileSync(
      join(root, s.name, "SKILL.md"),
      `---\nname: ${s.name}\ndescription: ${s.name} desc\n---\n${s.body}\n`,
    );
  }
  const tarball = join(work, "out.tar.gz");
  spawnSync("tar", ["-czf", tarball, "-C", work, "skills-main"], { stdio: "ignore" });
  return readFileSync(tarball);
}

/** Seed an installed skill dir (with a SKILL.md) under a canonical root. */
function seedSkill(canonicalRoot: string, name: string, body: string): void {
  const dir = join(canonicalRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: old\n---\n${body}\n`);
}

const okFetch = (bytes: Uint8Array<ArrayBuffer>): typeof fetch =>
  (() => Promise.resolve(new Response(bytes, { status: 200 }))) as unknown as typeof fetch;

describe("listInstalledSkills", () => {
  test("returns [] for a missing root", () => {
    expect(listInstalledSkills(join(tmpdir(), "does-not-exist-xyz"))).toEqual([]);
  });

  test("lists only dirs that contain a SKILL.md, sorted", () => {
    const root = mkdtempSync(join(tmpdir(), "installed-"));
    seedSkill(root, "bravo", "b");
    seedSkill(root, "alpha", "a");
    mkdirSync(join(root, "not-a-skill"), { recursive: true }); // no SKILL.md → excluded
    expect(listInstalledSkills(root)).toEqual(["alpha", "bravo"]);
  });
});

describe("runSkillsUpdate", () => {
  test("refreshes installed skills in place and does not add new ones", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "update-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "update-home-"));
    const canonical = join(cwd, ".agents", "skills");
    seedSkill(canonical, "reoclo-cli-usage", "OLD");

    const bytes = new Uint8Array(
      buildSkillsTarball([
        { name: "reoclo-cli-usage", body: "NEW" },
        { name: "other", body: "x" },
      ]),
    );

    const outcome = await runSkillsUpdate({ cwd, home, fetchImpl: okFetch(bytes) });
    expect(outcome.kind).toBe("updated");
    if (outcome.kind !== "updated") throw new Error("expected an updated outcome");
    expect(outcome.scope).toBe("project");
    expect(outcome.updated).toEqual(["reoclo-cli-usage"]);
    expect(outcome.missing).toEqual([]);

    // Content refreshed to the latest.
    expect(readFileSync(join(canonical, "reoclo-cli-usage", "SKILL.md"), "utf8")).toContain("NEW");
    // A skill that was NOT installed must not be added by update.
    expect(existsSync(join(canonical, "other"))).toBe(false);
    // No Claude tree existed, so update must not create one.
    expect(existsSync(join(cwd, ".claude", "skills"))).toBe(false);
  });

  test("reports `none` (and never fetches) when nothing is installed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "update-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "update-home-"));
    const throwFetch = (() => {
      throw new Error("fetch should not be called when nothing is installed");
    }) as unknown as typeof fetch;

    const outcome = await runSkillsUpdate({ cwd, home, fetchImpl: throwFetch });
    expect(outcome.kind).toBe("none");
    if (outcome.kind !== "none") throw new Error("expected a none outcome");
    expect(outcome.scope).toBe("project");
  });

  test("an installed skill no longer upstream is reported missing and left on disk", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "update-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "update-home-"));
    const canonical = join(cwd, ".agents", "skills");
    seedSkill(canonical, "reoclo-cli-usage", "OLD");
    seedSkill(canonical, "gone", "keep me");

    const bytes = new Uint8Array(buildSkillsTarball([{ name: "reoclo-cli-usage", body: "NEW" }]));

    const outcome = await runSkillsUpdate({ cwd, home, fetchImpl: okFetch(bytes) });
    expect(outcome.kind).toBe("updated");
    if (outcome.kind !== "updated") throw new Error("expected an updated outcome");
    expect(outcome.updated).toEqual(["reoclo-cli-usage"]);
    expect(outcome.missing).toEqual(["gone"]);
    // The now-removed-upstream skill stays untouched on disk.
    expect(readFileSync(join(canonical, "gone", "SKILL.md"), "utf8")).toContain("keep me");
  });

  test("returns an error outcome (does not throw) when the download fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "update-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "update-home-"));
    seedSkill(join(cwd, ".agents", "skills"), "reoclo-cli-usage", "OLD");
    const failing = (() =>
      Promise.resolve(new Response("nope", { status: 404 }))) as unknown as typeof fetch;

    const outcome = await runSkillsUpdate({ cwd, home, fetchImpl: failing });
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") throw new Error("expected an error outcome");
    expect(outcome.message).toContain("404");
  });

  test("--global refreshes the home root", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "update-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "update-home-"));
    const canonical = join(home, ".agents", "skills");
    seedSkill(canonical, "reoclo-cli-usage", "OLD");

    const bytes = new Uint8Array(buildSkillsTarball([{ name: "reoclo-cli-usage", body: "NEW" }]));

    const outcome = await runSkillsUpdate({ cwd, home, global: true, fetchImpl: okFetch(bytes) });
    expect(outcome.kind).toBe("updated");
    if (outcome.kind !== "updated") throw new Error("expected an updated outcome");
    expect(outcome.scope).toBe("global");
    expect(readFileSync(join(canonical, "reoclo-cli-usage", "SKILL.md"), "utf8")).toContain("NEW");
    expect(existsSync(join(cwd, ".agents", "skills"))).toBe(false);
  });

  test("re-links Claude's `.claude/skills` when that tree exists", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "update-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "update-home-"));
    seedSkill(join(cwd, ".agents", "skills"), "reoclo-cli-usage", "OLD");
    // A pre-existing Claude tree marks the harness as installed.
    mkdirSync(join(cwd, ".claude", "skills"), { recursive: true });

    const bytes = new Uint8Array(buildSkillsTarball([{ name: "reoclo-cli-usage", body: "NEW" }]));

    const outcome = await runSkillsUpdate({ cwd, home, fetchImpl: okFetch(bytes) });
    expect(outcome.kind).toBe("updated");

    const link = join(cwd, ".claude", "skills", "reoclo-cli-usage");
    expect(existsSync(link)).toBe(true);
    // It is a symlink to the canonical copy (not a real Windows-style copy here).
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(link, "SKILL.md"), "utf8")).toContain("NEW");
  });
});
