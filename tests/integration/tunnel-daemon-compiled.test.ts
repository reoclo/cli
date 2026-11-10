// The bundled binary loads modules differently from `bun test`, and a load-order
// failure there stops the daemon from starting while every unit test passes.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let binary: string;

async function run(...args: string[]): Promise<{ code: number; out: string }> {
  return runWith({}, ...args);
}

async function runWith(
  opts: { cwd?: string; env?: Record<string, string> },
  ...args: string[]
): Promise<{ code: number; out: string }> {
  const p = Bun.spawn([binary, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, REOCLO_CONFIG_DIR: join(dir, "config"), ...opts.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out: out + err };
}

/** A process's working directory, as the OS reports it. */
async function cwdOf(pid: number): Promise<string> {
  if (process.platform === "linux") return readlinkSync(`/proc/${String(pid)}/cwd`);
  const p = Bun.spawn(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  return out.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? "";
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "reoclo-compiled-"));
  binary = join(dir, "reoclo");
  const build = Bun.spawn(["bun", "build", "--compile", "src/index.ts", "--outfile", binary], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await build.exited).toBe(0);
}, 120_000);

afterAll(async () => {
  await run("tunnel", "daemon", "stop");
  rmSync(dir, { recursive: true, force: true });
});

describe("compiled binary", () => {
  it("starts, reports and stops the tunnel daemon", async () => {
    const start = await run("tunnel", "daemon", "start");
    expect(start.out).toContain("started");
    expect(start.code).toBe(0);

    const status = await run("tunnel", "daemon", "status");
    expect(status.code).toBe(0);
    expect(status.out).toMatch(/running\s+true/);

    const stop = await run("tunnel", "daemon", "stop");
    expect(stop.code).toBe(0);
  }, 60_000);

  it("lists approvals without a sign-in, and answers an unknown id with the daemon's error", async () => {
    const list = await run("tunnel", "approvals");
    expect(list.out).toContain("no pending approvals");
    expect(list.code).toBe(0);

    const start = await run("tunnel", "daemon", "start");
    expect(start.code).toBe(0);
    const approve = await run("tunnel", "approve", "nope");
    expect(approve.out).toContain('no approval with id "nope"');
    expect(approve.code).toBe(1);
    expect((await run("tunnel", "daemon", "stop")).code).toBe(0);
  }, 60_000);

  it("keeps a daemon on another config directory away from the real hosts helper", async () => {
    expect((await run("tunnel", "daemon", "start")).code).toBe(0);
    const status = await run("tunnel", "daemon", "status", "-o", "json");
    expect(status.out).toContain('"hosts_helper_installed": false');
    expect((await run("tunnel", "daemon", "stop")).code).toBe(0);

    const setup = await run("hosts", "setup");
    expect(setup.code).not.toBe(0);
    expect(setup.out).toContain("default config directory");
  }, 60_000);

  it("lists a tunnel running in a terminal and stops it", async () => {
    const child = Bun.spawn(["bash", "-c", 'exec -a "reoclo tunnel prod-1" sleep 60'], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const registry = join(dir, "config", "tunnels", "run", "foreground");
    mkdirSync(registry, { recursive: true });
    writeFileSync(
      join(registry, `${String(child.pid)}.json`),
      JSON.stringify({
        pid: child.pid,
        org: "acme",
        server: "prod-1",
        state: "active",
        started_at: "2026-11-09T10:00:00.000Z",
        forwards: [{ kind: "forward", proto: "tcp", listen: "127.0.0.1:7700", target: "127.0.0.1:7700" }],
      }),
    );
    expect((await run("tunnel", "daemon", "start")).code).toBe(0);
    const listed = await run("tunnel", "status");
    expect(listed.out).toContain("Running in a terminal");
    expect(listed.out).toContain("127.0.0.1:7700 -> 127.0.0.1:7700");

    const res = await fetch(`http://localhost/v1/foreground/${String(child.pid)}/stop`, {
      unix: join(dir, "config", "tunnels", "run", "tunneld.sock"),
      method: "POST",
    });
    expect(res.status).toBe(200);
    await child.exited;
    expect(child.signalCode).toBe("SIGTERM");

    expect((await run("tunnel", "status")).out).not.toContain("Running in a terminal");
    expect((await run("tunnel", "daemon", "stop")).code).toBe(0);
  }, 60_000);

  it("leaves the directory it was started from for the home directory", async () => {
    // Bun shell commands, such as the keychain read behind every sign-in, fail with ENOENT once the
    // working directory is deleted, so a daemon that kept a removed worktree as its cwd lost every tunnel.
    const home = realpathSync(mkdtempSync(join(dir, "home-")));
    const start = await runWith({ cwd: mkdtempSync(join(dir, "cwd-")), env: { HOME: home } }, "tunnel", "daemon", "start");
    expect(start.code).toBe(0);

    const pid = Number(/"pid":\s*(\d+)/.exec((await run("tunnel", "daemon", "status", "-o", "json")).out)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(await cwdOf(pid)).toBe(home);
    expect((await run("tunnel", "daemon", "stop")).code).toBe(0);
  }, 60_000);

  it("runs tunnel setup without a sign-in", async () => {
    const setup = await run("tunnel", "setup", "--no-service", "--no-trust", "--no-hosts", "-o", "json");
    expect(setup.code).toBe(0);
    expect(setup.out).toContain('"outcome": "skipped"');
    expect((await run("tunnel", "daemon", "stop")).code).toBe(0);
  }, 60_000);
});
