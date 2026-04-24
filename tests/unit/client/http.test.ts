import { expect, test, beforeAll, afterAll } from "bun:test";
import { HttpClient } from "../../../src/client/http";
import { AuthError, NotFoundError } from "../../../src/client/errors";

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/mcp/auth/me") {
        const auth = req.headers.get("authorization");
        if (auth !== "Bearer rk_t_good") return new Response("unauth", { status: 401 });
        return Response.json({ tenant_slug: "acme", email: "u@x" });
      }
      if (url.pathname === "/mcp/missing") return new Response("no", { status: 404 });
      return new Response("hi", { status: 200 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server.stop();
});

test("GET /auth/me with valid token returns body", async () => {
  const c = new HttpClient({ baseUrl: base, token: "rk_t_good" });
  const body = await c.get<{ tenant_slug: string; email: string }>("/auth/me");
  expect(body.tenant_slug).toBe("acme");
});

test("401 throws AuthError", async () => {
  const c = new HttpClient({ baseUrl: base, token: "rk_t_bad" });
  let caught: unknown = null;
  try {
    await c.get("/auth/me");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(AuthError);
});

test("404 throws NotFoundError", async () => {
  const c = new HttpClient({ baseUrl: base, token: "rk_t_good" });
  let caught: unknown = null;
  try {
    await c.get("/missing");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(NotFoundError);
});
