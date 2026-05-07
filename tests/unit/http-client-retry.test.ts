import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { HttpClient } from "../../src/client/http";
import { PermissionError } from "../../src/client/errors";

// Mock updateProfileCapabilities so no disk I/O occurs in tests
mock.module("../../src/config/store", () => ({
  updateProfileCapabilities: mock(() => Promise.resolve()),
  loadConfig: mock(() => Promise.resolve({ active_profile: "default", profiles: {} })),
  saveProfile: mock(() => Promise.resolve()),
  deleteProfile: mock(() => Promise.resolve()),
  getActiveProfile: mock(() => Promise.resolve(null)),
  setActiveProfile: mock(() => Promise.resolve()),
}));

function makeClient() {
  return new HttpClient({
    baseUrl: "https://api.example.com",
    token: "sk_tenant_testtoken",
    profile: "default",
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

describe("HttpClient 403 retry", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true })));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("403 → refresh /auth/me/capabilities → retry original → success (3 fetch calls)", async () => {
    let callCount = 0;
    globalThis.fetch = mock((url: string) => {
      callCount++;
      const u = url as string;
      if (callCount === 1) {
        // First call: original request → 403
        return Promise.resolve(textResponse("forbidden", 403));
      }
      if (u.includes("/auth/me/capabilities")) {
        // Second call: caps refresh → success
        return Promise.resolve(jsonResponse({ capabilities: ["cost:read"] }));
      }
      // Third call: retry original → success
      return Promise.resolve(jsonResponse({ data: "ok" }));
    }) as typeof fetch;

    const client = makeClient();
    const result = await client.get<{ data: string }>("/cost/rollup");
    expect(result).toEqual({ data: "ok" });
    expect(callCount).toBe(3);
  });

  test("403 on retry → throws PermissionError, no infinite loop (caps endpoint called once)", async () => {
    let gatedCalls = 0;
    let capsCalls = 0;
    globalThis.fetch = mock((url: string) => {
      const u = url as string;
      if (u.includes("/auth/me/capabilities")) {
        capsCalls++;
        return Promise.resolve(jsonResponse({ capabilities: [] }));
      }
      gatedCalls++;
      // Both the original and retry return 403
      return Promise.resolve(textResponse("forbidden", 403));
    }) as typeof fetch;

    const client = makeClient();
    await expect(client.get("/cost/rollup")).rejects.toBeInstanceOf(PermissionError);
    expect(gatedCalls).toBe(2);   // original + one retry
    expect(capsCalls).toBe(1);    // caps refresh called exactly once
  });
});
