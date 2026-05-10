import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { HttpClient } from "../../../src/client/http";
import { AuthError } from "../../../src/client/errors";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textRes(body: string, status: number): Response {
  return new Response(body, { status });
}

describe("HttpClient 401 refresh", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("401 with no refreshToken callback throws AuthError", async () => {
    globalThis.fetch = mock(() => Promise.resolve(textRes("unauthorized", 401))) as unknown as typeof fetch;

    const client = new HttpClient({
      baseUrl: "https://api.example.com",
      token: "eyJold.token",
    });

    await expect(client.get("/auth/me")).rejects.toBeInstanceOf(AuthError);
  });

  test("401 with successful refresh retries with new token and returns 200 result", async () => {
    let callCount = 0;
    let lastAuthHeader = "";

    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      callCount++;
      lastAuthHeader = (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
      if (callCount === 1) {
        // First call returns 401
        return Promise.resolve(textRes("unauthorized", 401));
      }
      // Retry after refresh returns success
      return Promise.resolve(jsonRes({ data: "ok" }));
    }) as unknown as typeof fetch;

    let refreshCalled = false;
    const client = new HttpClient({
      baseUrl: "https://api.example.com",
      token: "eyJold.token",
      refreshToken: async () => {
        refreshCalled = true;
        return "eyJnew.token";
      },
    });

    const result = await client.get<{ data: string }>("/auth/me");
    expect(result).toEqual({ data: "ok" });
    expect(refreshCalled).toBe(true);
    expect(callCount).toBe(2);
    // The retry should use the new token
    expect(lastAuthHeader).toBe("Bearer eyJnew.token");
  });

  test("401 with failing refresh (returns null) throws AuthError", async () => {
    globalThis.fetch = mock(() => Promise.resolve(textRes("unauthorized", 401))) as unknown as typeof fetch;

    const client = new HttpClient({
      baseUrl: "https://api.example.com",
      token: "eyJold.token",
      refreshToken: async () => null,
    });

    await expect(client.get("/auth/me")).rejects.toBeInstanceOf(AuthError);
  });

  test("401 with refresh that throws returns AuthError (no loop)", async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(() => {
      fetchCount++;
      return Promise.resolve(textRes("unauthorized", 401));
    }) as unknown as typeof fetch;

    const client = new HttpClient({
      baseUrl: "https://api.example.com",
      token: "eyJold.token",
      refreshToken: async () => { throw new Error("refresh failed"); },
    });

    await expect(client.get("/auth/me")).rejects.toBeInstanceOf(AuthError);
    // Only the original fetch — no retry since refresh threw
    expect(fetchCount).toBe(1);
  });
});
