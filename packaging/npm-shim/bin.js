#!/usr/bin/env node
// packaging/npm-shim/bin.js
const { spawnSync } = require("node:child_process");
const archMap = { x64: "x64", arm64: "arm64" };
const osMap = { darwin: "darwin", linux: "linux", win32: "windows" };
const ext = process.platform === "win32" ? ".exe" : "";
const arch = archMap[process.arch];
const plat = osMap[process.platform];
if (!arch || !plat) {
  console.error(`Unsupported platform: ${process.platform}-${process.arch}`);
  process.exit(1);
}
const pkg = `@reoclo/cli-${plat}-${arch}`;
let bin;
try {
  bin = require.resolve(`${pkg}/reoclo${ext}`);
} catch {
  console.error(`Error: ${pkg} is not installed for this platform.`);
  console.error("Install via: brew install reoclo/tap/reoclo  OR  curl -sSL https://get.reoclo.com/cli | bash");
  process.exit(1);
}
const r = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
process.exit(r.status ?? 0);
