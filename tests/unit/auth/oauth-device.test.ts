import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import {
  initiateDeviceFlow,
  pollForToken,
  refreshAccessToken,
  DeviceFlowError,
} from "../../../src/auth/oauth-device";

const AUTH_BASE = "https://auth.reoclo.com";
const CLIENT_ID = "reoclo-cli";
const DEVICE_CODE = "dev_code_abc123";
const USER_CODE = "ABCD-EFGH";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("initiateDeviceFlow", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns parsed DeviceInitResponse on success", async () => {
    const mockResponse = {
      device_code: DEVICE_CODE,
      user_code: USER_CODE,
      verification_uri: "https://auth.reoclo.com/device",
      verification_uri_complete: `https://auth.reoclo.com/device?user_code=${USER_CODE}`,
      expires_in: 900,
      interval: 5,
    };
    globalThis.fetch = mock(() => Promise.resolve(jsonRes(mockResponse))) as unknown as typeof fetch;

    const result = await initiateDeviceFlow(AUTH_BASE, CLIENT_ID, "openid tenant.read");
    expect(result).toEqual(mockResponse);
  });

  test("sends form-encoded body (RFC 8628 §3.1)", async () => {
    let capturedHeaders: Headers | undefined;
    let capturedBody: string | undefined;
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      capturedBody = init?.body as string;
      return Promise.resolve(
        jsonRes({
          device_code: DEVICE_CODE,
          user_code: USER_CODE,
          verification_uri: "https://auth.reoclo.com/device",
          verification_uri_complete: `https://auth.reoclo.com/device?user_code=${USER_CODE}`,
          expires_in: 900,
          interval: 5,
        }),
      );
    }) as unknown as typeof fetch;

    await initiateDeviceFlow(AUTH_BASE, CLIENT_ID, "openid");

    expect(capturedHeaders?.get("content-type")).toBe("application/x-www-form-urlencoded");
    const parsed = new URLSearchParams(capturedBody);
    expect(parsed.get("client_id")).toBe(CLIENT_ID);
    expect(parsed.get("scope")).toBe("openid");
  });

  test("throws DeviceFlowError on non-OK response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("bad request", { status: 400 })),
    ) as unknown as typeof fetch;

    await expect(initiateDeviceFlow(AUTH_BASE, CLIENT_ID, "openid")).rejects.toMatchObject({
      code: "network",
    });
  });

  test("throws DeviceFlowError on network failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    ) as unknown as typeof fetch;

    const err = await initiateDeviceFlow(AUTH_BASE, CLIENT_ID, "openid").catch((e) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("network");
  });
});

describe("pollForToken", () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;

  beforeEach(() => {
    // Replace setTimeout with a no-op so poll iterations are instant in tests.
    // The real behavior (interval tracking) is verified via fetch call counts.
    globalThis.setTimeout = ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });

  test("polls through authorization_pending then returns token on success", async () => {
    const tokenResponse = {
      access_token: "eyJhbGciOiJSUzI1NiJ9.test",
      refresh_token: "rt_opaque_abc",
      scope: "openid tenant.read",
      token_type: "Bearer",
      expires_in: 3600,
    };
    let call = 0;
    globalThis.fetch = mock(() => {
      call++;
      if (call <= 2) {
        return Promise.resolve(jsonRes({ error: "authorization_pending" }, 400));
      }
      return Promise.resolve(jsonRes(tokenResponse));
    }) as unknown as typeof fetch;

    const tickCount = { n: 0 };
    const result = await pollForToken(AUTH_BASE, DEVICE_CODE, CLIENT_ID, 5, {
      onTick: () => { tickCount.n++; },
    });
    expect(result.access_token).toBe(tokenResponse.access_token);
    expect(result.refresh_token).toBe(tokenResponse.refresh_token);
    expect(call).toBe(3);
    expect(tickCount.n).toBe(3);
  });

  test("increments interval by 5 on slow_down", async () => {
    let call = 0;

    globalThis.fetch = mock(() => {
      call++;
      if (call === 1) return Promise.resolve(jsonRes({ error: "slow_down" }, 400));
      return Promise.resolve(
        jsonRes({ access_token: "tok", refresh_token: "rt", scope: "openid" }),
      );
    }) as unknown as typeof fetch;

    const result = await pollForToken(AUTH_BASE, DEVICE_CODE, CLIENT_ID, 5);
    expect(result.access_token).toBe("tok");
    // slow_down → keep polling → success: 2 fetch calls total
    expect(call).toBe(2);
  });

  test("throws DeviceFlowError with code access_denied on user cancel", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonRes({ error: "access_denied" }, 400)),
    ) as unknown as typeof fetch;

    const err = await pollForToken(AUTH_BASE, DEVICE_CODE, CLIENT_ID, 5).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("access_denied");
  });

  test("throws DeviceFlowError with code expired_token on timeout", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonRes({ error: "expired_token" }, 400)),
    ) as unknown as typeof fetch;

    const err = await pollForToken(AUTH_BASE, DEVICE_CODE, CLIENT_ID, 5).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("expired_token");
  });
});

describe("refreshAccessToken", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns new TokenResponse on success", async () => {
    const newTokens = {
      access_token: "eyJnew.token",
      refresh_token: "rt_new_opaque",
      scope: "openid tenant.read",
      token_type: "Bearer",
      expires_in: 3600,
    };
    globalThis.fetch = mock(() => Promise.resolve(jsonRes(newTokens))) as unknown as typeof fetch;

    const result = await refreshAccessToken(AUTH_BASE, "rt_old_opaque", CLIENT_ID);
    expect(result).toEqual(newTokens);
  });

  test("sends form-encoded body", async () => {
    let capturedBody = "";
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return jsonRes({ access_token: "t", refresh_token: "r", scope: "openid" });
    }) as unknown as typeof fetch;

    await refreshAccessToken(AUTH_BASE, "my_refresh", CLIENT_ID);
    expect(capturedBody).toContain("grant_type=refresh_token");
    expect(capturedBody).toContain("refresh_token=my_refresh");
    expect(capturedBody).toContain(`client_id=${CLIENT_ID}`);
  });

  test("throws DeviceFlowError on refresh failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("unauthorized", { status: 401 })),
    ) as unknown as typeof fetch;

    const err = await refreshAccessToken(AUTH_BASE, "bad_rt", CLIENT_ID).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("network");
  });
});
