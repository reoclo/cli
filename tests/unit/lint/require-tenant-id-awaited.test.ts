import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
  for (const f of tsFiles("src")) {
    if (f.endsWith("client/bootstrap.ts")) continue; // the definition lives here
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (!line.includes("requireTenantId(")) return; // import lines have no "("
      const awaited = /await\s+requireTenantId\(/.test(line);
      if (!awaited) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(offenders).toEqual([]);
});
