import { expect, test, beforeAll, afterAll } from "bun:test";
import { HttpClient } from "../../../src/client/http";

// Own server (CI runs each file in its own process). `rk_t_*` tokens route
// through the `/mcp` prefix. `/mcp/guarded` 403s to trigger the self-heal;
// `/mcp/auth/me/capabilities` returns a caps body the self-heal fetches.
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/mcp/auth/me/capabilities") {
        return Response.json({
          capabilities: [{ verb: "container:read", scope_kind: "tenant", scope_id: null }],
        });
      }
      if (url.pathname === "/mcp/guarded") return new Response("forbidden", { status: 403 });
      return new Response("hi", { status: 200 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server.stop();
});

async function drive403(profile: string | undefined): Promise<string[][]> {
  const persisted: string[][] = [];
  const c = new HttpClient({
    baseUrl: base,
    token: "rk_t_good",
    profile,
    onCapabilities: (_p, caps) => {
      persisted.push(caps);
      return Promise.resolve();
    },
  });
  try {
    await c.get("/guarded");
  } catch {
    // the original 403 resurfaces after the one-shot self-heal; irrelevant here
  }
  // self-heal persist is fire-and-forget (`void persist(...)`); let it settle
  await new Promise((r) => setTimeout(r, 20));
  return persisted;
}

test("403 self-heal persists caps when a profile is set", async () => {
  const persisted = await drive403("default");
  expect(persisted).toEqual([["container:read"]]);
});

test("403 self-heal does NOT persist when profile is undefined (env credential)", async () => {
  const persisted = await drive403(undefined);
  expect(persisted).toEqual([]);
});
