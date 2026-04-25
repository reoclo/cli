#!/usr/bin/env node
// packaging/npm-shim-theta/bin.js
//
// @reoclo/theta v2.x is a compatibility shim. The original theta-mcp package
// has been replaced by the unified `reoclo` CLI's stdio MCP subcommand. This
// shim downloads the platform-matched `reoclo` binary on first run and execs
// `reoclo mcp` so that existing Claude Code / Cursor / Windsurf configs
// pointing at `npx -y @reoclo/theta` continue to work.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");
const https = require("node:https");

// Pin the CLI release this shim downloads. Bump on each @reoclo/theta release.
const VERSION = "1.0.0";

const cacheRoot = join(os.homedir(), ".cache", "reoclo", "bin");
const archMap = { x64: "x64", arm64: "arm64" };
const platMap = { darwin: "darwin", linux: "linux", win32: "windows" };
const arch = archMap[process.arch];
const plat = platMap[process.platform];

if (!arch || !plat) {
  process.stderr.write(`Unsupported platform: ${process.platform}-${process.arch}\n`);
  process.exit(1);
}

const ext = plat === "windows" ? ".exe" : "";
const binPath = join(cacheRoot, `reoclo-${VERSION}-${plat}-${arch}${ext}`);

function ensureBin(cb) {
  if (fs.existsSync(binPath)) return cb();
  fs.mkdirSync(cacheRoot, { recursive: true });
  const url = `https://github.com/reoclo/cli/releases/download/v${VERSION}/reoclo-${plat}-${arch}${ext}`;
  process.stderr.write(`Downloading reoclo v${VERSION} (${plat}-${arch}) from GitHub releases...\n`);
  download(url, binPath, (err) => {
    if (err) {
      process.stderr.write(`Download failed: ${err.message}\n`);
      process.stderr.write(`Install manually: brew install reoclo/tap/reoclo  OR  curl -sSL https://get.reoclo.com/cli | bash\n`);
      process.exit(1);
    }
    if (plat !== "windows") fs.chmodSync(binPath, 0o755);
    cb();
  });
}

function download(url, dest, cb) {
  https
    .get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location, dest, cb);
      }
      if (res.statusCode !== 200) {
        return cb(new Error(`HTTP ${res.statusCode}`));
      }
      const tmp = `${dest}.tmp`;
      const stream = fs.createWriteStream(tmp);
      res.pipe(stream);
      stream.on("finish", () => {
        stream.close(() => {
          fs.renameSync(tmp, dest);
          cb(null);
        });
      });
      stream.on("error", cb);
    })
    .on("error", cb);
}

ensureBin(() => {
  const r = spawnSync(binPath, ["mcp", ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(r.status ?? 0);
});
