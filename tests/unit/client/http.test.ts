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
      // Echo the observed path so tests can assert exactly which prefix a
      // request landed on, rather than only checking an object property.
      return Response.json({ path: url.pathname });
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

test("prefix override wins over the token-derived prefix", async () => {
  // rk_m_ tokens derive to /mcp; withPrefix must pin the machine lane to
  // /api/automation/v1 regardless of what the token itself would derive.
  const c = new HttpClient({ baseUrl: base, token: "rk_m_a" }).withPrefix("/api/automation/v1");
  const body = await c.get<{ path: string }>("/secrets/accessible-projects");
  expect(body.path).toBe("/api/automation/v1/secrets/accessible-projects");
});

test("withToken preserves an explicit prefix", async () => {
  // machineResolver opens a session and re-issues resolve() against the
  // rss_ session token via withToken(); the derived client must stay on
  // the automation prefix, not fall back to the token-derived one.
  //
  // The new token is deliberately tenant-shaped (rk_t_), NOT rss_/rk_a_/
  // rca_/rk_m_. If it were automation- or machine-shaped, the no-override
  // fallback `apiPrefix(detectKeyType(token))` would independently land on
  // the same /api/automation/v1 value and the assertion below couldn't tell
  // "prefix survived" from "prefix happened to be re-derived" — a
  // tenant-shaped token derives to /mcp on its own, so only genuine
  // survival of the override produces /api/automation/v1 here.
  const c = new HttpClient({ baseUrl: base, token: "rk_m_a" })
    .withPrefix("/api/automation/v1")
    .withToken("rk_t_b");
  const body = await c.get<{ path: string }>("/secrets/resolve");
  expect(body.path).toBe("/api/automation/v1/secrets/resolve");
});
