import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installSkills,
  placeSkills,
  resolveSkillsHead,
  selectSkills,
  skillsTarballUrl,
  toPortableFrontmatter,
} from "../../../src/init/skills";

/** Build a codeload-style tarball (single top-level dir) and return its bytes. */
function buildSkillsTarball(): Buffer {
  const work = mkdtempSync(join(tmpdir(), "skills-fixture-"));
  const root = join(work, "skills-main");
  mkdirSync(join(root, "reoclo-cli-usage"), { recursive: true });
  writeFileSync(join(root, "reoclo-cli-usage", "SKILL.md"), "# usage\n");
  mkdirSync(join(root, "reoclo-api"), { recursive: true });
  writeFileSync(join(root, "reoclo-api", "SKILL.md"), "# api\n");
  writeFileSync(join(root, "README.md"), "readme\n"); // not a skill dir
  const tarball = join(work, "out.tar.gz");
  spawnSync("tar", ["-czf", tarball, "-C", work, "skills-main"], { stdio: "ignore" });
  return readFileSync(tarball);
}

describe("selectSkills", () => {
  test("with no request, selects all available skills", () => {
    expect(selectSkills(["a", "b", "c"])).toEqual({ selected: ["a", "b", "c"], missing: [] });
  });

  test("an empty request array is treated as 'all'", () => {
    expect(selectSkills(["a", "b"], [])).toEqual({ selected: ["a", "b"], missing: [] });
  });

  test("selects only the requested subset, in available order", () => {
    expect(selectSkills(["a", "b", "c"], ["c", "a"])).toEqual({
      selected: ["a", "c"],
      missing: [],
    });
  });

  test("reports requested names that are not available", () => {
    expect(selectSkills(["a", "b"], ["a", "x"])).toEqual({ selected: ["a"], missing: ["x"] });
  });

  test("trims and dedupes requested names", () => {
    expect(selectSkills(["a", "b"], [" a ", "a", "b"])).toEqual({
      selected: ["a", "b"],
      missing: [],
    });
  });
});

describe("skillsTarballUrl", () => {
  test("defaults to the main branch codeload tarball", () => {
    expect(skillsTarballUrl()).toBe(
      "https://codeload.github.com/reoclo/skills/tar.gz/refs/heads/main",
    );
  });
});

describe("installSkills", () => {
  const bytes = new Uint8Array(buildSkillsTarball());
  const fetchImpl = (() =>
    Promise.resolve(new Response(bytes, { status: 200 }))) as unknown as typeof fetch;

  test("downloads, extracts skill dirs, and copies them into destDir", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "dest-")), ".claude", "skills");
    const result = await installSkills({ destDir: dest, fetchImpl });
    expect(result.installed.sort()).toEqual(["reoclo-api", "reoclo-cli-usage"]);
    expect(result.missing).toEqual([]);
    expect(existsSync(join(dest, "reoclo-cli-usage", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dest, "reoclo-api", "SKILL.md"))).toBe(true);
    // README.md is not a skill dir and must not be copied.
    expect(existsSync(join(dest, "README.md"))).toBe(false);
  });

  test("installs only the requested subset and reports missing ones", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "dest-")), ".claude", "skills");
    const result = await installSkills({
      destDir: dest,
      requested: ["reoclo-cli-usage", "nope"],
      fetchImpl,
    });
    expect(result.installed).toEqual(["reoclo-cli-usage"]);
    expect(result.missing).toEqual(["nope"]);
    expect(existsSync(join(dest, "reoclo-cli-usage", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dest, "reoclo-api"))).toBe(false);
  });

  test("throws a clear error when the download fails", async () => {
    const failing = (() =>
      Promise.resolve(new Response("nope", { status: 404 }))) as unknown as typeof fetch;
    const dest = join(mkdtempSync(join(tmpdir(), "dest-")), ".claude", "skills");
    await expect(installSkills({ destDir: dest, fetchImpl: failing })).rejects.toThrow(/404/);
  });
});

test("resolveSkillsHead returns the branch head sha", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ sha: "deadbeef" }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
  expect(await resolveSkillsHead("main", fetchImpl)).toBe("deadbeef");
});

test("resolveSkillsHead returns null on non-ok / rate-limit (no throw)", async () => {
  const fetchImpl = (async () => new Response("rate limited", { status: 403 })) as unknown as typeof fetch;
  expect(await resolveSkillsHead("main", fetchImpl)).toBeNull();
});

test("toPortableFrontmatter keeps only the six portable fields", () => {
  const raw = [
    "---",
    "name: reoclo-cli-usage",
    "description: Use when operating reoclo from the terminal",
    "allowed-tools: Bash Read",
    "context: fork",          // Claude-only vendor extension -> dropped
    "paths: src/**",          // Claude-only -> dropped
    "---",
    "",
    "# Body stays",
  ].join("\n");
  const out = toPortableFrontmatter(raw);
  expect(out).toContain("name: reoclo-cli-usage");
  expect(out).toContain("description: Use when operating reoclo from the terminal");
  expect(out).toContain("allowed-tools: Bash Read");
  expect(out).not.toContain("context:");
  expect(out).not.toContain("paths:");
  expect(out).toContain("# Body stays");
});

test("toPortableFrontmatter leaves a body-only file untouched", () => {
  const raw = "# no frontmatter here";
  expect(toPortableFrontmatter(raw)).toBe(raw);
});

function fakePlaceFs() {
  const calls: string[] = [];
  const files: Record<string, string> = {};
  return {
    calls,
    files,
    fs: {
      isWindows: false,
      mkdir: (p: string) => calls.push(`mkdir ${p}`),
      cpDir: (from: string, to: string) => calls.push(`cp ${from} -> ${to}`),
      readFile: (p: string) => files[p] ?? "---\nname: x\ndescription: y\n---\nbody",
      writeFile: (p: string, c: string) => { files[p] = c; calls.push(`write ${p}`); },
      symlink: (target: string, link: string) => calls.push(`ln ${link} -> ${target}`),
    },
  };
}

test("placeSkills copies portable skills to canonical root and symlinks Claude", () => {
  const { fs, calls } = fakePlaceFs();
  placeSkills({
    sourceRoot: "/src",
    selected: ["alpha"],
    placement: {
      canonicalRoot: join("/proj", ".agents", "skills"),
      symlinkDirs: [join("/proj", ".claude", "skills")],
      pointerFiles: [],
    },
    fsImpl: fs,
  });
  const dst = join("/proj", ".agents", "skills", "alpha");
  expect(calls).toContain(`cp ${join("/src", "alpha")} -> ${dst}`);
  // Claude symlink points at the canonical skill dir.
  expect(calls).toContain(
    `ln ${join("/proj", ".claude", "skills", "alpha")} -> ${dst}`,
  );
});

test("placeSkills copies instead of symlinking on Windows", () => {
  const { fs, calls } = fakePlaceFs();
  fs.isWindows = true;
  placeSkills({
    sourceRoot: "/src",
    selected: ["alpha"],
    placement: {
      canonicalRoot: join("/proj", ".agents", "skills"),
      symlinkDirs: [join("/proj", ".claude", "skills")],
      pointerFiles: [],
    },
    fsImpl: fs,
  });
  expect(calls.some((c) => c.startsWith("ln "))).toBe(false);
  expect(calls).toContain(
    `cp ${join("/proj", ".agents", "skills", "alpha")} -> ${join("/proj", ".claude", "skills", "alpha")}`,
  );
});
