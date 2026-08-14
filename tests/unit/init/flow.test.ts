import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSkillsInstall } from "../../../src/init/flow";

/** Build a codeload-style tarball (single top-level dir) and return its bytes. */
function buildSkillsTarball(): Buffer {
  const work = mkdtempSync(join(tmpdir(), "flow-fixture-"));
  const root = join(work, "skills-main");
  mkdirSync(join(root, "reoclo-cli-usage"), { recursive: true });
  writeFileSync(
    join(root, "reoclo-cli-usage", "SKILL.md"),
    "---\nname: reoclo-cli-usage\ndescription: usage\n---\nbody\n",
  );
  const tarball = join(work, "out.tar.gz");
  spawnSync("tar", ["-czf", tarball, "-C", work, "skills-main"], { stdio: "ignore" });
  return readFileSync(tarball);
}

describe("runSkillsInstall", () => {
  const bytes = new Uint8Array(buildSkillsTarball());
  const fetchImpl = (() =>
    Promise.resolve(new Response(bytes, { status: 200 }))) as unknown as typeof fetch;

  test("installs under project scope by default and reports the outcome", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "flow-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "flow-home-"));
    const outcome = await runSkillsInstall({
      assumeYes: true,
      flagHarness: ["claude"],
      cwd,
      home,
      fetchImpl,
    });
    expect(outcome.kind).toBe("installed");
    if (outcome.kind !== "installed") throw new Error("expected an installed outcome");
    expect(outcome.scope).toBe("project");
    expect(outcome.selection).toEqual(["claude"]);
    expect(outcome.installed).toEqual(["reoclo-cli-usage"]);
    expect(outcome.missing).toEqual([]);
    expect(existsSync(join(cwd, ".agents", "skills", "reoclo-cli-usage", "SKILL.md"))).toBe(true);
    // Claude reads `.claude/skills`, so an explicit claude selection links it.
    expect(existsSync(join(cwd, ".claude", "skills", "reoclo-cli-usage"))).toBe(true);
  });

  test("an explicit --global flag installs under the home destinations", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "flow-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "flow-home-"));
    const outcome = await runSkillsInstall({
      assumeYes: true,
      flagHarness: ["claude"],
      global: true,
      cwd,
      home,
      fetchImpl,
    });
    expect(outcome.kind).toBe("installed");
    if (outcome.kind !== "installed") throw new Error("expected an installed outcome");
    expect(outcome.scope).toBe("global");
    expect(existsSync(join(home, ".agents", "skills", "reoclo-cli-usage", "SKILL.md"))).toBe(true);
    expect(existsSync(join(cwd, ".agents", "skills"))).toBe(false);
  });

  test("a requested subset that doesn't exist is reported as missing, not thrown", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "flow-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "flow-home-"));
    const outcome = await runSkillsInstall({
      assumeYes: true,
      flagHarness: ["claude"],
      requested: ["nope"],
      cwd,
      home,
      fetchImpl,
    });
    expect(outcome.kind).toBe("installed");
    if (outcome.kind !== "installed") throw new Error("expected an installed outcome");
    expect(outcome.installed).toEqual([]);
    expect(outcome.missing).toEqual(["nope"]);
  });

  test("returns an error outcome (does not throw) when the download fails", async () => {
    const failing = (() =>
      Promise.resolve(new Response("nope", { status: 404 }))) as unknown as typeof fetch;
    const cwd = mkdtempSync(join(tmpdir(), "flow-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "flow-home-"));
    const outcome = await runSkillsInstall({
      assumeYes: true,
      flagHarness: ["claude"],
      cwd,
      home,
      fetchImpl: failing,
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") throw new Error("expected an error outcome");
    expect(outcome.message).toContain("404");
  });
});
