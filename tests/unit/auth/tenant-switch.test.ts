import { describe, expect, test } from "bun:test";
import { mintTenantSwitchToken, TenantSwitchError } from "../../../src/auth/tenant-switch";
import { NetworkError } from "../../../src/client/errors";

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

  describe("connection resets (field report 2026-09-24)", () => {
    // `.reoclo` / --org switches org by POSTing this grant with the full access
    // token in the body, so it is as exposed to the edge reset as any GET. The
    // grant reuses the caller's session and rotates nothing server-side
    // (api/routers/oauth.py tenant_switch -> switch_access_token), so sending it
    // again after a reset is safe.
    function bunReset(): Error & { code: string } {
      const e = new Error(
        "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      ) as Error & { code: string };
      e.code = "ECONNRESET";
      return e;
    }
    const params = {
      authUrl: "https://auth.reoclo.com",
      clientId: "reoclo-cli",
      currentAccessToken: "t",
      tenantId: "x",
    };
    const noSleep = { sleep: (): Promise<void> => Promise.resolve() };

    test("a reset before any response is retried", async () => {
      let calls = 0;
      const fetchImpl = (): Promise<Response> => {
        calls++;
        return calls === 1
          ? Promise.reject(bunReset())
          : Promise.resolve(jsonResponse({ access_token: "minted" }));
      };
      const token = await mintTenantSwitchToken(params, fetchImpl, noSleep);
      expect(token).toBe("minted");
      expect(calls).toBe(2);
    });

    test("a persistent reset surfaces as NetworkError (exit 7) with a hint, not Bun's raw error", async () => {
      const fetchImpl = (): Promise<Response> => Promise.reject(bunReset());
      const err = (await mintTenantSwitchToken(params, fetchImpl, noSleep).catch(
        (e: unknown) => e,
      )) as NetworkError;
      expect(err).toBeInstanceOf(NetworkError);
      expect(err.exitCode).toBe(7);
      expect(err.message).toContain("POST https://auth.reoclo.com/oauth/token");
      expect(err.message).not.toContain("second argument to fetch");
      expect(err.hint).toContain("--verbose");
    });

    test("the verbose log never contains the access token sent in the body", async () => {
      const lines: string[] = [];
      const fetchImpl = (): Promise<Response> =>
        Promise.resolve(jsonResponse({ access_token: "minted" }));
      await mintTenantSwitchToken(
        { ...params, currentAccessToken: "very-secret-access" },
        fetchImpl,
        {
          ...noSleep,
          log: (l) => lines.push(l),
        },
      );
      const text = lines.join("\n");
      expect(text).toContain("POST https://auth.reoclo.com/oauth/token");
      expect(text).not.toContain("very-secret-access");
      expect(text).not.toContain("minted");
    });
  });
});
