#!/usr/bin/env node
// packaging/npm-shim/bin.js
const { spawnSync } = require("node:child_process");
const { basename } = require("node:path");
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
// The binary names itself after argv[0], so pass on the name this shim was
// run as: `rc` when run through the rc bin, `reoclo` otherwise.
const r = spawnSync(bin, process.argv.slice(2), {
  stdio: "inherit",
  argv0: basename(process.argv[1] || "reoclo"),
});
if (r.error) {
  console.error(`Error: could not run ${bin}: ${r.error.message}`);
  process.exit(1);
}
if (r.signal) process.kill(process.pid, r.signal);
process.exit(r.status ?? 1);
