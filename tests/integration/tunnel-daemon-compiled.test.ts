// The bundled binary loads modules differently from `bun test`, and a load-order
// failure there stops the daemon from starting while every unit test passes.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let binary: string;

async function run(...args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn([binary, ...args], {
    env: { ...process.env, REOCLO_CONFIG_DIR: join(dir, "config") },
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
});
