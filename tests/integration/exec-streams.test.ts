import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { seedTenantProfile } from "../helpers/seed-profile";

const T = "00000000-0000-0000-0000-00000000aaaa";
const SERVER = "11111111-1111-4111-8111-111111111111";
const TOKEN = "rk_t_test";

interface Seen {
  path: string;
  auth: string | null;
  body: unknown;
}

let tmp: string;
let api: ReturnType<typeof Bun.serve>;
let streams: ReturnType<typeof Bun.serve>;
let apiSeen: Seen[];
let streamsSeen: Seen[];

function execServer(log: Seen[]): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const text = await req.text();
      log.push({
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization"),
        body: text === "" ? undefined : JSON.parse(text),
      });
      return Response.json({ exit_code: 0, stdout: "ok", stderr: "", truncated: false });
    },
  });
}

beforeEach(() => {
  apiSeen = [];
  streamsSeen = [];
  api = execServer(apiSeen);
  streams = execServer(streamsSeen);
  tmp = mkdtempSync(join(tmpdir(), "reoclo-exec-streams-"));
  seedTenantProfile({ configDir: tmp, apiUrl: `http://localhost:${api.port}`, token: TOKEN });
});

afterEach(() => {
  void api.stop(true);
  void streams.stop(true);
});

async function exec(args: string[], streamsUrl?: string): Promise<{ stdout: string; exitCode: number }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    REOCLO_CONFIG_DIR: tmp,
    REOCLO_CACHE_DIR: join(tmp, "cache"),
  };
  if (streamsUrl !== undefined) env["REOCLO_STREAMS_URL"] = streamsUrl;
  const proc = Bun.spawn(["bun", "run", "src/index.ts", "exec", SERVER, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, exitCode };
}

test("a long exec goes to the streams host, unprefixed, with the same token", async () => {
  const r = await exec(["--", "echo", "ok"], `http://localhost:${streams.port}`);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe("ok");
  expect(apiSeen).toHaveLength(0);
  expect(streamsSeen).toHaveLength(1);
  expect(streamsSeen[0]?.path).toBe(`/tenants/${T}/servers/${SERVER}/exec`);
  expect(streamsSeen[0]?.auth).toBe(`Bearer ${TOKEN}`);
  expect(streamsSeen[0]?.body).toMatchObject({ timeout: 600 });
});

test("a short exec stays on the API host under /mcp", async () => {
  const r = await exec(["--timeout", "30", "--", "echo", "ok"], `http://localhost:${streams.port}`);
  expect(r.exitCode).toBe(0);
  expect(streamsSeen).toHaveLength(0);
  expect(apiSeen[0]?.path).toBe(`/mcp/tenants/${T}/servers/${SERVER}/exec`);
});

test("with no separate streams host a long exec stays on the API host", async () => {
  const r = await exec(["--", "echo", "ok"]);
  expect(r.exitCode).toBe(0);
  expect(apiSeen[0]?.path).toBe(`/mcp/tenants/${T}/servers/${SERVER}/exec`);
});
