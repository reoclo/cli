import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Resolved relative to this test file (not process.cwd()) so the scan finds
// `src` regardless of which directory `bun test` is invoked from — a cwd-
// relative "src" throws ENOENT instead of reporting offenders when run from
// anywhere else.
const SRC_DIR = join(import.meta.dir, "../../../src");

// Built with `join` (platform separator) rather than a hardcoded "client/bootstrap.ts"
// forward slash, so the exclusion still matches on a path-separator platform
// other than the one this was written on — this repo has a documented history
// of path-separator test failures.
const BOOTSTRAP_SUFFIX = join("client", "bootstrap.ts");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

test("every requireTenantId call is awaited", () => {
  // A forgotten await stringifies a Promise into "[object Promise]" inside a
  // /tenants/{tid} URL — typecheck cannot stop a template literal, so this
  // source scan is the gate that outlives this diff.
  const offenders: string[] = [];
  for (const f of tsFiles(SRC_DIR)) {
    if (f.endsWith(BOOTSTRAP_SUFFIX)) continue; // the definition lives here
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (!line.includes("requireTenantId(")) return; // import lines have no "("
      const awaited = /await\s+requireTenantId\(/.test(line);
      if (!awaited) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(offenders).toEqual([]);
});
