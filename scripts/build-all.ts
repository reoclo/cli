// scripts/build-all.ts
import { $ } from "bun";
import { mkdirSync, rmSync } from "node:fs";

const targets = [
  { name: "linux-x64",        bun: "bun-linux-x64" },
  { name: "linux-x64-musl",   bun: "bun-linux-x64-musl" },
  { name: "linux-arm64",      bun: "bun-linux-arm64" },
  { name: "darwin-x64",       bun: "bun-darwin-x64" },
  { name: "darwin-arm64",     bun: "bun-darwin-arm64" },
  { name: "windows-x64",      bun: "bun-windows-x64" },
] as const;

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

for (const t of targets) {
  const ext = t.name.startsWith("windows") ? ".exe" : "";
  const out = `dist/reoclo-${t.name}${ext}`;
  console.log(`→ ${t.name}`);
  await $`bun build --compile --target=${t.bun} --minify --sourcemap=none src/index.ts --outfile ${out}`;
}

console.log("\n✓ built", targets.length, "binaries in dist/");
