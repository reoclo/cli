import { test, expect } from "bun:test";
import { HttpClient } from "../../../src/client/http";

test("updateToken swaps the bearer used by subsequent requests", async () => {
  const seen: string[] = [];
  const orig = globalThis.fetch;
  // @ts-expect-error test stub
  globalThis.fetch = async (_url: string, init: RequestInit) => {
    seen.push(String((init.headers as Record<string, string>).Authorization));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const c = new HttpClient({ baseUrl: "https://api.example.test", token: "tok-a" });
    await c.get("/auth/me");
    c.updateToken("tok-b");
    await c.get("/auth/me");
    expect(seen[0]).toBe("Bearer tok-a");
    expect(seen[1]).toBe("Bearer tok-b");
  } finally {
    globalThis.fetch = orig;
  }
});
