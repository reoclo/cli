// A copy of the runtime inside a fake Reoclo.app stands in for the bundled CLI: the
// real binary is a Bun-compiled executable, and `reoclo upgrade` reads its own path.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "../../../src/index.ts");

let root: string;
let bundleDir: string;
let viaSymlink: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "reoclo-desktop-copy-"));
  bundleDir = join(root, "Reoclo.app", "Contents", "Resources");
  mkdirSync(bundleDir, { recursive: true });
  copyFileSync(process.execPath, join(bundleDir, "reoclo"), constants.COPYFILE_FICLONE);
  mkdirSync(join(root, "bin"));
  viaSymlink = join(root, "bin", "reoclo");
  symlinkSync(join(bundleDir, "reoclo"), viaSymlink);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function run(binary: string, ...args: string[]) {
  const proc = Bun.spawn([binary, ENTRY, ...args], {
    env: { ...process.env, REOCLO_CONFIG_DIR: join(root, "config"), REOCLO_NO_UPDATE_CHECK: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

for (const [label, pick] of [
  ["directly", () => join(bundleDir, "reoclo")],
  ["through the symlink", () => viaSymlink],
] as const) {
  test(`upgrade on the desktop copy, reached ${label}, exits 0 and leaves the bundle untouched`, async () => {
    const before = statSync(join(bundleDir, "reoclo")).mtimeMs;
    const { code } = await run(pick(), "upgrade");
    expect(code).toBe(0);
    expect(readdirSync(bundleDir)).toEqual(["reoclo"]);
    expect(statSync(join(bundleDir, "reoclo")).mtimeMs).toBe(before);
  });
}

test("--version on the desktop copy leads with the version and names the install type", async () => {
  const { stdout, code } = await run(viaSymlink, "--version");
  expect(code).toBe(0);
  const [version, ...rest] = stdout.trim().split(/\s+/);
  expect(version).toMatch(/^\d+\.\d+\.\d+/);
  expect(rest.length).toBeGreaterThan(0);
});
