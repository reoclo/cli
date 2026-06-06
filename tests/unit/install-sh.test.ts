import { describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Guards packaging/install.sh against bash-only constructs. The script is the
// documented `curl -sSL https://get.reoclo.com | sh` install method and is piped
// to `sh` (dash) by every CI wrapper, so it MUST be POSIX. A bash shebang + `[[ ]]`
// once shipped, which broke under dash (`[[: not found`) so `--version` never
// parsed → fell back to "latest" → 404 → the CLI never installed.
const SCRIPT = join(import.meta.dir, "..", "..", "packaging", "install.sh");
const src = readFileSync(SCRIPT, "utf8");
// Code with full-line comments stripped — so the bashism checks don't trip on a
// comment that *mentions* `[[ ]]`, nor on legit `[[:space:]]` char classes / `==>`
// echo banners that appear in real code.
const code = src
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"))
  .join("\n");

describe("packaging/install.sh is POSIX sh (static lint)", () => {
  test("POSIX sh shebang, not bash", () => {
    const firstLine = src.split("\n")[0] ?? "";
    expect(firstLine).toBe("#!/bin/sh");
  });

  test("no bash-only `[[ ` test keyword (POSIX `[[:class:]]` is fine)", () => {
    expect(code).not.toMatch(/\[\[ /);
  });

  test("no bash-only ` == ` test operator (POSIX test uses `=`)", () => {
    expect(code).not.toMatch(/ == /);
  });

  test("no 'pipefail' (unsupported by POSIX sh / dash)", () => {
    expect(code).not.toContain("pipefail");
  });
});

describe("packaging/install.sh executes under dash", () => {
  const hasDash = !spawnSync("dash", ["-c", ":"]).error;
  const maybe = hasDash ? test : test.skip;

  maybe("parses --version under dash (regression: must not fall back to 'latest')", () => {
    const dir = mkdtempSync(join(tmpdir(), "reoclo-install-guard-"));
    const fakeVersion = "v0.0.0-ci-guard";
    // The download 404s for this nonexistent version — we only assert that arg
    // parsing (the formerly bash-only code path) ran correctly under dash, which
    // is printed before the download is attempted.
    const r = spawnSync(
      "dash",
      [SCRIPT, "--version", fakeVersion, "--install-dir", dir, "--no-modify-path"],
      { encoding: "utf8", timeout: 30_000 },
    );
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out).not.toMatch(/\[\[: not found/);
    expect(out).toContain(`Downloading reoclo ${fakeVersion}`);
    expect(out).not.toContain("Downloading reoclo latest");
  });
});
