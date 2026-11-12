// tests/helpers/fake-test-api.ts
//
// A scripted HTTP fake for the test server routes. Routes are keyed "METHOD /path"
// (without the /mcp prefix); a handler may return a Response, null (204) or JSON.
// Every request is recorded so a test can assert on the bodies the CLI sent.

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export type RouteHandler = (req: Recorded) => unknown;
export type Routes = Record<string, RouteHandler | object | null>;

export interface FakeTestApi {
  url: string;
  token: string;
  requests: Recorded[];
  calls: (method: string, path: string) => Recorded[];
  stop: () => void;
}

export function startFakeTestApi(routes: Routes): FakeTestApi {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/mcp/, "");
      const text = await req.text();
      const recorded: Recorded = { method: req.method, path, query: url.searchParams, body: text ? JSON.parse(text) : undefined };
      requests.push(recorded);
      const route = routes[`${req.method} ${path}`];
      if (route === undefined) return Response.json({ detail: "Not Found" }, { status: 404 });
      const out = typeof route === "function" ? (route as RouteHandler)(recorded) : route;
      if (out instanceof Response) return out;
      if (out === null) return new Response(null, { status: 204 });
      return Response.json(out);
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    token: "rk_t_test",
    requests,
    calls: (method, path) => requests.filter((r) => r.method === method && r.path === path),
    stop: () => void server.stop(true),
  };
}
