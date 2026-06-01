import { describe, expect, test } from "bun:test";
import { mintTenantSwitchToken, TenantSwitchError } from "../../../src/auth/tenant-switch";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("mintTenantSwitchToken", () => {
  test("posts the tenant_switch grant and returns the access token", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const fetchImpl = (url: string, init: RequestInit): Promise<Response> => {
      capturedUrl = url;
      capturedBody = typeof init.body === "string" ? init.body : "";
      return Promise.resolve(jsonResponse({ access_token: "new-token" }));
    };
    const token = await mintTenantSwitchToken(
      {
        authUrl: "https://auth.reoclo.com/", // trailing slash should be trimmed
        clientId: "reoclo-cli",
        currentAccessToken: "old-token",
        tenantId: "tid-123",
      },
      fetchImpl,
    );
    expect(token).toBe("new-token");
    expect(capturedUrl).toBe("https://auth.reoclo.com/oauth/token");
    expect(capturedBody).toContain("grant_type=tenant_switch");
    expect(capturedBody).toContain("tenant_id=tid-123");
    expect(capturedBody).toContain("current_access_token=old-token");
    expect(capturedBody).toContain("client_id=reoclo-cli");
  });

  test("throws TenantSwitchError with the server error_description on non-2xx", async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.resolve(
        jsonResponse(
          { detail: { error: "tenant_not_granted", error_description: "no access to org" } },
          403,
        ),
      );
    let caught: unknown;
    try {
      await mintTenantSwitchToken(
        {
          authUrl: "https://auth.reoclo.com",
          clientId: "reoclo-cli",
          currentAccessToken: "t",
          tenantId: "x",
        },
        fetchImpl,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TenantSwitchError);
    expect((caught as Error).message).toContain("no access to org");
    expect((caught as Error).message).toContain("403");
    expect((caught as { exitCode?: number }).exitCode).toBe(1);
  });

  test("surfaces a non-JSON error body as-is", async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.resolve(new Response("upstream boom", { status: 500 }));
    let caught: unknown;
    try {
      await mintTenantSwitchToken(
        {
          authUrl: "https://auth.reoclo.com",
          clientId: "reoclo-cli",
          currentAccessToken: "t",
          tenantId: "x",
        },
        fetchImpl,
      );
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toContain("upstream boom");
  });
});
