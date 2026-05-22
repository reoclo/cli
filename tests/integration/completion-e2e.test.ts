// tests/integration/completion-e2e.test.ts
//
// Automated bash tab-completion e2e using node-pty (a real pseudo-terminal).
// Zsh/fish parity is covered by the manual test plan at:
//   docs/superpowers/specs/2026-05-19-tab-completion-test-plan.md
//
// The tests spin up an interactive bash session, source the CLI's own bash
// completion shim (with `reoclo` aliased to `bun run src/index.ts`), type a
// partial command followed by TAB, and assert that the terminal output
// contains the expected completions.
//
// Skip conditions (any → all 3 skip cleanly):
//   - node-pty not installed / no prebuilt binary for this platform
//   - bash not available on PATH

import { expect, test, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type * as NodePty from "node-pty";
import { startFakeGateway, type FakeGateway } from "../helpers/fake-gateway";
import { seedTenantProfile } from "../helpers/seed-profile";

// node-pty is loaded lazily so the test gracefully skips on platforms where
// it's not available (e.g., Windows CI without prebuilt binaries).
let pty: typeof NodePty | undefined;
try {
  pty = await import("node-pty");
} catch {
  pty = undefined;
}

// Probe whether node-pty can actually spawn a PTY on this platform/sandbox.
// Some CI environments block posix_spawnp even when node-pty loads fine.
let ptySpawnWorks = false;
if (pty) {
  try {
    const probe = pty.spawn("bash", ["--norc", "-c", "exit 0"], {
      name: "xterm",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    let exitedOk = false;
    await new Promise<void>((resolve) => {
      probe.onExit(({ exitCode }) => { exitedOk = exitCode === 0; resolve(); });
      setTimeout(() => { try { probe.kill(); } catch { /* ignore */ } resolve(); }, 2000);
    });
    ptySpawnWorks = exitedOk;
  } catch {
    ptySpawnWorks = false;
  }
}

let tmp: string;
let gw: FakeGateway;

beforeEach(() => {
  gw = startFakeGateway();
  tmp = mkdtempSync(join(tmpdir(), "reoclo-comp-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function bashAvailable(): boolean {
  try {
    const r = Bun.spawnSync({ cmd: ["bash", "--version"], stdout: "pipe", stderr: "pipe" });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

// Absolute path to the CLI source so the bash shim can call it without
// relying on a built binary on PATH.
const CLI_SRC = join(process.cwd(), "src/index.ts");
const BUN_BIN = process.execPath; // absolute path to the running bun binary

async function ptySession(line: string): Promise<string> {
  if (!pty) throw new Error("node-pty unavailable");

  // Write a bash completion shim that:
  //   1. defines `reoclo` as a function that delegates to `bun src/index.ts`
  //   2. sources the CLI's own completion script (which registers _reoclo)
  //   3. re-registers the completion function against the `reoclo` shell function
  const shimPath = join(tmp, "reoclo-bash-comp.sh");
  const shim = [
    `# Alias reoclo → bun run src/index.ts for completion e2e`,
    `reoclo() { "${BUN_BIN}" run "${CLI_SRC}" "$@"; }`,
    `export -f reoclo`,
    ``,
    `# Source the CLI's own bash completion shim verbatim.`,
    `# It registers complete -F _reoclo reoclo; _reoclo calls reoclo __complete`,
    `eval "$("${BUN_BIN}" run "${CLI_SRC}" completion bash 2>/dev/null)"`,
  ].join("\n");
  writeFileSync(shimPath, shim);

  const term = pty.spawn("bash", ["--norc", "-i"], {
    name: "xterm-color",
    cols: 120,
    rows: 30,
    cwd: process.cwd(),
    env: {
      ...process.env,
      PS1: "$ ",
      REOCLO_CONFIG_DIR: tmp,
      REOCLO_CACHE_DIR: join(tmp, "cache"),
    },
  });

  let buf = "";
  term.onData((d) => {
    buf += d;
  });

  // Source the shim, then type the test line + TAB.
  term.write(`source ${shimPath}\n`);
  term.write(line + "\t");

  // Wait for completion to settle (bash + bun startup overhead).
  await new Promise((r) => setTimeout(r, 2000));
  term.kill();
  return buf;
}

test.skipIf(!pty || !ptySpawnWorks || !bashAvailable())(
  "bash: `reoclo serv<TAB>` completes to `servers`",
  async () => {
    const out = await ptySession("reoclo serv");
    expect(out).toContain("servers");
  },
);

test.skipIf(!pty || !ptySpawnWorks || !bashAvailable())(
  "bash: `reoclo audit ls --action <TAB>` shows the action enum",
  async () => {
    const out = await ptySession("reoclo audit ls --action ");
    expect(out).toMatch(/deploy_succeeded|update|delete|create/);
  },
);

test.skipIf(!pty || !ptySpawnWorks || !bashAvailable())(
  "bash: `reoclo monitors get <TAB>` shows monitor slugs after cache is warmed",
  async () => {
    await $`bun run src/index.ts monitors create --name comp-mon --url https://example.com`.env({
      ...process.env,
      REOCLO_CONFIG_DIR: tmp,
      REOCLO_CACHE_DIR: join(tmp, "cache"),
    }).quiet();
    await $`bun run src/index.ts monitors ls`.env({
      ...process.env,
      REOCLO_CONFIG_DIR: tmp,
      REOCLO_CACHE_DIR: join(tmp, "cache"),
    }).quiet();
    const out = await ptySession("reoclo monitors get ");
    expect(out).toContain("comp-mon");
  },
);
