// src/commands/upgrade.ts
import type { Command } from "commander";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { argv0, execPath, platform as nodePlatform, arch as nodeArch } from "node:process";
import { createHash } from "node:crypto";
import { VERSION } from "../index";

interface UpgradeOpts {
  channel: string;
  version?: string;
  check?: boolean;
}

interface BuildTarget {
  os: "linux" | "darwin" | "windows";
  arch: "x64" | "arm64";
  binName: string;
  isWindows: boolean;
}

/**
 * Resolve the absolute path of the running CLI binary.
 *
 * `process.argv[0]` is often just the bare command name ("reoclo") when the
 * binary is invoked via $PATH lookup, which makes `realpathSync(argv0)`
 * throw ENOENT. We prefer `process.execPath` (always absolute), fall back
 * to argv0 if it's already absolute, and otherwise resolve it via $PATH.
 */
function resolveSelfPath(): string {
  // execPath is always an absolute path to the running executable. For
  // Bun-compiled single-file binaries this is exactly what we want.
  if (execPath && isAbsolute(execPath)) {
    try {
      return realpathSync(execPath);
    } catch {
      // fall through to argv0
    }
  }
  if (argv0 && isAbsolute(argv0)) {
    return realpathSync(argv0);
  }
  // argv0 was a bare name — search PATH.
  const pathDirs = (process.env["PATH"] ?? "").split(":");
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = `${dir}/${argv0}`;
    if (existsSync(candidate)) {
      return realpathSync(candidate);
    }
  }
  throw new Error(
    `cannot resolve running CLI binary path (argv0=${argv0}, execPath=${execPath})`,
  );
}

function detectTarget(): BuildTarget {
  let os: BuildTarget["os"];
  switch (nodePlatform) {
    case "linux":
      os = "linux";
      break;
    case "darwin":
      os = "darwin";
      break;
    case "win32":
      os = "windows";
      break;
    default:
      throw new Error(`unsupported platform: ${nodePlatform}`);
  }
  let arch: BuildTarget["arch"];
  switch (nodeArch) {
    case "x64":
      arch = "x64";
      break;
    case "arm64":
      arch = "arm64";
      break;
    default:
      throw new Error(`unsupported arch: ${nodeArch}`);
  }
  const isWindows = os === "windows";
  const binName = `reoclo-${os}-${arch}${isWindows ? ".exe" : ""}`;
  return { os, arch, binName, isWindows };
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

async function fetchBinary(url: string): Promise<Buffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

function parseSha256For(sumsText: string, name: string): string | null {
  for (const raw of sumsText.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // Format: "<hex>  <filename>" (BSD shasum / GNU sha256sum agree on this)
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const filename = parts[parts.length - 1];
    if (filename === name) {
      return parts[0] ?? null;
    }
  }
  return null;
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function selfUpgradeRawBinary(currentPath: string, tag: string): Promise<void> {
  const target = detectTarget();

  if (target.isWindows) {
    throw new Error(
      "raw-binary self-upgrade is not supported on Windows (the running .exe is locked); re-run the installer manually",
    );
  }

  if (!isWritable(currentPath)) {
    throw new Error(
      `cannot write to ${currentPath} — re-run with elevated privileges (e.g. sudo) or upgrade your install dir's owner`,
    );
  }
  const dir = dirname(currentPath);
  if (!isWritable(dir)) {
    throw new Error(`cannot write to install directory ${dir} — re-run with elevated privileges`);
  }

  const ghBase = `https://github.com/reoclo/cli/releases/download/${tag}`;
  const binUrl = `${ghBase}/${target.binName}`;
  const sumsUrl = `${ghBase}/SHA256SUMS`;

  process.stdout.write(`==> Downloading ${target.binName} from ${tag}...\n`);
  const sumsText = await fetchText(sumsUrl);
  const expectedSum = parseSha256For(sumsText, target.binName);
  if (!expectedSum) {
    throw new Error(`no SHA256 entry for ${target.binName} in ${sumsUrl}`);
  }
  const binData = await fetchBinary(binUrl);
  const actualSum = createHash("sha256").update(binData).digest("hex");
  if (actualSum !== expectedSum) {
    throw new Error(
      `checksum mismatch for ${target.binName} (got ${actualSum}, expected ${expectedSum})`,
    );
  }
  process.stdout.write(`==> Checksum verified (sha256: ${actualSum.slice(0, 12)}…)\n`);

  // Atomic in-place swap. POSIX rename keeps the running process pinned to
  // the old inode via the kernel's open file table, so it's safe to rename
  // the binary that's currently executing.
  const newPath = `${currentPath}.new`;
  const oldPath = `${currentPath}.old`;
  writeFileSync(newPath, binData, { mode: 0o755 });
  try {
    if (existsSync(oldPath)) unlinkSync(oldPath);
  } catch {
    // Best-effort cleanup — not fatal if it fails.
  }
  renameSync(currentPath, oldPath);
  renameSync(newPath, currentPath);
  chmodSync(currentPath, 0o755);

  process.stdout.write(`✓ Upgraded to ${tag} at ${currentPath}\n`);
  process.stdout.write(`  Previous binary kept at ${oldPath} (safe to delete after restart).\n`);
}

export function registerUpgrade(program: Command): void {
  program
    .command("upgrade")
    .description("self-update the CLI (or print upgrade instructions for managed installs)")
    .option("--channel <name>", "stable | beta | dev", "stable")
    .option("--version <ver>", "pin to a specific version (overrides --channel)")
    .option("--check", "only check, do not upgrade")
    .action(async (opts: UpgradeOpts) => {
      const current = VERSION;

      // Resolve the version we want.
      let latest: string;
      if (opts.version) {
        latest = opts.version.startsWith("v") ? opts.version : `v${opts.version}`;
      } else {
        try {
          latest = (await fetchText(`https://get.reoclo.com/cli/${opts.channel}`)).trim();
        } catch (err) {
          const e = err as Error;
          process.stderr.write(`Error: failed to fetch channel pointer (${e.message})\n`);
          process.exit(7);
        }
      }

      if (opts.check) {
        process.stdout.write(`current: ${current}\n`);
        process.stdout.write(`latest:  ${latest}\n`);
        return;
      }

      if (!opts.version && latest === `v${current}`) {
        process.stdout.write(`✓ already on latest (${current})\n`);
        return;
      }

      const self = resolveSelfPath();

      if (self.includes("/node_modules/")) {
        process.stdout.write("Installed via npm. Upgrade with:\n");
        process.stdout.write(`  npm i -g @reoclo/cli@${latest.replace(/^v/, "")}\n`);
        return;
      }
      if (self.includes("/Cellar/") || self.toLowerCase().includes("/homebrew/")) {
        process.stdout.write("Installed via Homebrew. Upgrade with:\n");
        process.stdout.write("  brew upgrade reoclo/tap/reoclo\n");
        return;
      }

      // Raw-binary install — perform the in-place swap.
      try {
        await selfUpgradeRawBinary(self, latest);
      } catch (err) {
        const e = err as Error;
        process.stderr.write(`Error: ${e.message}\n`);
        process.stderr.write("Fallback: re-run the installer:\n");
        process.stderr.write("  curl -sSL https://get.reoclo.com/cli | bash\n");
        process.exit(1);
      }
    });
}
