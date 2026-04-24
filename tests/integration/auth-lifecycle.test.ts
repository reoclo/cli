// tests/integration/auth-lifecycle.test.ts
import { expect, test, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmp: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reoclo-it-"));

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/auth/me") {
        const auth = req.headers.get("authorization");
        if (auth !== "Bearer rk_t_fake") return new Response("unauth", { status: 401 });
        return Response.json({
          id: "u1",
          email: "test@example.com",
          tenant_id: "t1",
          tenant_slug: "acme",
          roles: ["member"],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterEach(() => {
  void server.stop();
});

test("login → whoami → logout (file store, fake gateway)", async () => {
  const env = { ...process.env, REOCLO_CONFIG_DIR: tmp };

  await $`bun run src/index.ts login --token rk_t_fake --api ${base} --no-keyring`.env(env);

  const who = await $`bun run src/index.ts whoami`.env(env).quiet();
  const out = who.stdout.toString();
  expect(out).toContain("tenant:  acme");
  expect(out).toContain("user:    test@example.com");
  expect(out).toContain("type:    tenant");

  await $`bun run src/index.ts logout`.env(env);

  const after = await $`bun run src/index.ts whoami`.env(env).nothrow().quiet();
  expect(after.exitCode).toBe(3);
});
