// REO-434: output past the 64 KB pipe buffer was cut off when stdout was a pipe
// and the process then exited. Runs the real entry point with a piped stdout.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { seedTenantProfile } from "../helpers/seed-profile";

const TOKEN = "rk_t_test";
const BIG_ITEMS = 40_000;

let tmp: string;
let server: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/mcp/big") {
        return Response.json({
          items: Array.from({ length: BIG_ITEMS }, (_, i) => `item-${i}`),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  tmp = mkdtempSync(join(tmpdir(), "reoclo-pipe-"));
  seedTenantProfile({ configDir: tmp, apiUrl: `http://localhost:${server.port}`, token: TOKEN });
});

afterEach(() => {
  void server.stop(true);
});

async function runPiped(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") },
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, exitCode };
}

test("a large `reoclo api` response arrives whole through a pipe", async () => {
  const { stdout, exitCode } = await runPiped(["api", "/big"]);
  expect(exitCode).toBe(0);
  expect(stdout.length).toBeGreaterThan(300_000);
  const parsed = JSON.parse(stdout) as { items: string[] };
  expect(parsed.items).toHaveLength(BIG_ITEMS);
  expect(parsed.items[BIG_ITEMS - 1]).toBe(`item-${BIG_ITEMS - 1}`);
});
