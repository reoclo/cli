// tests/unit/client/secrets.test.ts
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { HttpClient } from "../../../src/client/http";
import { accessibleProjects, openSession, resolve, mergeEnv } from "../../../src/client/secrets";

// ---------------------------------------------------------------------------
// machineLane() coverage: accessibleProjects/openSession/resolve must cross
// a machine-shaped (rk_m_) token to /api/automation/v1, even though rk_m_
// otherwise derives to /mcp. Drives a *real* HttpClient against a Bun.serve
// seam and asserts the actual request path, so deleting the machineLane()
// wrap from any of the three functions is caught here (the fakes in
// tests/unit/secrets/resolvers.test.ts expose get/post directly and would
// not notice).
// ---------------------------------------------------------------------------

describe("machine lane prefix crossing", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        // Echo the observed path/method so tests assert the real request
        // destination, not just a property read off the client.
        return Response.json({ path: url.pathname, method: req.method });
      },
    });
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    void server.stop();
  });

  test("accessibleProjects crosses a machine token to the automation prefix", async () => {
    const c = new HttpClient({ baseUrl: base, token: "rk_m_a" });
    const body = (await accessibleProjects(c)) as unknown as { path: string; method: string };
    expect(body.path).toBe("/api/automation/v1/secrets/accessible-projects");
    expect(body.method).toBe("GET");
  });

  test("openSession crosses a machine token to the automation prefix", async () => {
    const c = new HttpClient({ baseUrl: base, token: "rk_m_a" });
    const body = (await openSession(c, ["p1"], {})) as unknown as { path: string; method: string };
    expect(body.path).toBe("/api/automation/v1/secrets/open-session");
    expect(body.method).toBe("POST");
  });

  test("resolve crosses a machine token to the automation prefix", async () => {
    const c = new HttpClient({ baseUrl: base, token: "rk_m_a" });
    const body = (await resolve(c, ["p1"])) as unknown as { path: string; method: string };
    expect(body.path).toBe("/api/automation/v1/secrets/resolve");
    expect(body.method).toBe("POST");
  });
});

describe("mergeEnv", () => {
  test("resolved values win over base and undefined base entries are dropped", () => {
    const out = mergeEnv({ PATH: "/bin", A: undefined, B: "base" }, { B: "secret", C: "new" });
    expect(out).toEqual({ PATH: "/bin", B: "secret", C: "new" });
  });

  test("empty resolved leaves defined base entries unchanged", () => {
    const out = mergeEnv({ X: "x", Y: undefined }, {});
    expect(out).toEqual({ X: "x" });
  });

  test("empty base returns all resolved entries", () => {
    const out = mergeEnv({}, { A: "1", B: "2" });
    expect(out).toEqual({ A: "1", B: "2" });
  });

  test("resolved completely overrides all overlapping base keys", () => {
    const out = mergeEnv({ A: "old", B: "old" }, { A: "new", B: "new" });
    expect(out).toEqual({ A: "new", B: "new" });
  });
});
