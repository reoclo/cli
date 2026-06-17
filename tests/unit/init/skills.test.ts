import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkills, selectSkills, skillsTarballUrl } from "../../../src/init/skills";

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
