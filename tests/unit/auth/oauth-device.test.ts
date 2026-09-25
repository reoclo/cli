import { describe, expect, test, mock, afterEach } from "bun:test";
import { setVerbose } from "../../../src/client/verbose";
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

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's .rejects.toMatchObject() returns void in its type definitions, not a Promise; await is harmless but ESLint incorrectly flags it
    await expect(initiateDeviceFlow(AUTH_BASE, CLIENT_ID, "openid")).rejects.toMatchObject({
      code: "network",
    });
  });

  test("throws DeviceFlowError on network failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    ) as unknown as typeof fetch;

    const err = await initiateDeviceFlow(AUTH_BASE, CLIENT_ID, "openid").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("network");
  });
});

describe("pollForToken", () => {
  const originalFetch = globalThis.fetch;
  // An instant poll sleep, injected rather than stubbing the global setTimeout:
  // the transport's per-request timeout runs on setTimeout too, and a stub that
  // fires at once would time out every poll. The real interval behavior is
  // verified through fetch call counts and the recorded waits.
  const fast = { sleep: (): Promise<void> => Promise.resolve() };

  afterEach(() => {
    globalThis.fetch = originalFetch;
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
      ...fast,
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

    const waits: number[] = [];
    const result = await pollForToken(AUTH_BASE, DEVICE_CODE, CLIENT_ID, 5, {
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(result.access_token).toBe("tok");
    // slow_down → keep polling → success: 2 fetch calls total
    expect(call).toBe(2);
    // ...and the second poll waited 5 s longer than the first.
    expect(waits).toEqual([5000, 10000]);
  });

  test("throws DeviceFlowError with code access_denied on user cancel", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonRes({ error: "access_denied" }, 400)),
    ) as unknown as typeof fetch;

    const err = await pollForToken(AUTH_BASE, DEVICE_CODE, CLIENT_ID, 5, fast).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("access_denied");
  });

  test("throws DeviceFlowError with code expired_token on timeout", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonRes({ error: "expired_token" }, 400)),
    ) as unknown as typeof fetch;

    const err = await pollForToken(AUTH_BASE, DEVICE_CODE, CLIENT_ID, 5, fast).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("expired_token");
  });

  test("tolerates FastAPI-wrapped errors: {detail: {error: 'authorization_pending'}}", async () => {
    const tokenResponse = {
      access_token: "tok",
      refresh_token: "rt",
      scope: "openid",
      token_type: "Bearer",
      expires_in: 3600,
    };
    let call = 0;
    globalThis.fetch = mock(() => {
      call++;
      if (call <= 2) {
        // FastAPI default wraps HTTPException(detail={...}) as {"detail": {...}}.
        return Promise.resolve(
          jsonRes({ detail: { error: "authorization_pending" } }, 400),
        );
      }
      return Promise.resolve(jsonRes(tokenResponse));
    }) as unknown as typeof fetch;

    const result = await pollForToken(AUTH_BASE, DEVICE_CODE, CLIENT_ID, 5, fast);
    expect(result.access_token).toBe("tok");
    expect(call).toBe(3);
  });

  test("tolerates FastAPI-wrapped access_denied", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonRes({ detail: { error: "access_denied" } }, 400)),
    ) as unknown as typeof fetch;

    const err = await pollForToken(AUTH_BASE, DEVICE_CODE, CLIENT_ID, 5, fast).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("access_denied");
  });
});

describe("device login on a network that resets connections (field report 2026-09-24)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function bunReset(): Error & { code: string } {
    const e = new Error(
      "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
    ) as Error & { code: string };
    e.code = "ECONNRESET";
    return e;
  }
  const fast = { sleep: (): Promise<void> => Promise.resolve() };
  const deviceInit = {
    device_code: DEVICE_CODE,
    user_code: USER_CODE,
    verification_uri: "https://auth.reoclo.com/device",
    verification_uri_complete: `https://auth.reoclo.com/device?user_code=${USER_CODE}`,
    expires_in: 900,
    interval: 5,
  };

  test("starting the device flow retries a reset", async () => {
    // Safe to repeat: a lost response leaves at most one unused device code,
    // which expires on its own.
    let calls = 0;
    globalThis.fetch = mock(() => {
      calls++;
      return calls === 1 ? Promise.reject(bunReset()) : Promise.resolve(jsonRes(deviceInit));
    }) as unknown as typeof fetch;

    const result = await initiateDeviceFlow(AUTH_BASE, CLIENT_ID, "openid", fast);

    expect(result.user_code).toBe(USER_CODE);
    expect(calls).toBe(2);
  });

  test("a device flow that cannot start reads as plain words", async () => {
    globalThis.fetch = mock(() => Promise.reject(bunReset())) as unknown as typeof fetch;

    const err = (await initiateDeviceFlow(AUTH_BASE, CLIENT_ID, "openid", fast).catch(
      (e: unknown) => e,
    )) as DeviceFlowError;

    expect(err).toBeInstanceOf(DeviceFlowError);
    expect(err.code).toBe("network");
    expect(err.message).toContain("closed the connection before responding");
    expect(err.message).not.toContain("second argument to fetch");
  });

  test("one reset between polls does not end the login: the next poll carries on", async () => {
    let calls = 0;
    globalThis.fetch = mock(() => {
      calls++;
      if (calls === 1) return Promise.resolve(jsonRes({ error: "authorization_pending" }, 400));
      if (calls === 2) return Promise.reject(bunReset());
      return Promise.resolve(jsonRes({ access_token: "tok", refresh_token: "rt", scope: "openid" }));
    }) as unknown as typeof fetch;

    const result = await pollForToken(AUTH_BASE, DEVICE_CODE, CLIENT_ID, 5, fast);

    expect(result.access_token).toBe("tok");
    expect(calls).toBe(3);
  });

  test("polls that keep failing end the login with plain words", async () => {
    let calls = 0;
    globalThis.fetch = mock(() => {
      calls++;
      return Promise.reject(bunReset());
    }) as unknown as typeof fetch;

    const err = (await pollForToken(AUTH_BASE, DEVICE_CODE, CLIENT_ID, 5, fast).catch(
      (e: unknown) => e,
    )) as DeviceFlowError;

    expect(err).toBeInstanceOf(DeviceFlowError);
    expect(err.code).toBe("network");
    expect(err.message).toContain("closed the connection before responding");
    expect(err.message).not.toContain("second argument to fetch");
    expect(calls).toBe(3);
  });

  test("the failed-poll count resets after any answer: only failures in a row end the login", async () => {
    // fail, fail, pending, fail, fail, success: never 3 in a row.
    const plan = ["fail", "fail", "pending", "fail", "fail", "ok"];
    let calls = 0;
    globalThis.fetch = mock(() => {
      const step = plan[calls++];
      if (step === "fail") return Promise.reject(bunReset());
      if (step === "pending") return Promise.resolve(jsonRes({ error: "authorization_pending" }, 400));
      return Promise.resolve(jsonRes({ access_token: "tok", refresh_token: "rt", scope: "openid" }));
    }) as unknown as typeof fetch;

    const result = await pollForToken(AUTH_BASE, DEVICE_CODE, CLIENT_ID, 5, fast);

    expect(result.access_token).toBe("tok");
    expect(calls).toBe(6);
  });

  test("a failed poll doubles the wait before the next one (RFC 8628 section 3.5)", async () => {
    const waits: number[] = [];
    let calls = 0;
    globalThis.fetch = mock(() => {
      calls++;
      return calls === 1
        ? Promise.reject(bunReset())
        : Promise.resolve(jsonRes({ access_token: "tok", refresh_token: "rt", scope: "openid" }));
    }) as unknown as typeof fetch;

    await pollForToken(AUTH_BASE, DEVICE_CODE, CLIENT_ID, 5, {
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });

    expect(waits).toEqual([5000, 10000]);
  });

  test("the failure backoff stops at 60 s, so scattered failures cannot outlast the device code", async () => {
    const plan = ["fail", "fail", "pending", "fail", "fail", "pending", "fail", "fail", "ok"];
    const waits: number[] = [];
    let calls = 0;
    globalThis.fetch = mock(() => {
      const step = plan[calls++];
      if (step === "fail") return Promise.reject(bunReset());
      if (step === "pending") return Promise.resolve(jsonRes({ error: "authorization_pending" }, 400));
      return Promise.resolve(jsonRes({ access_token: "tok", refresh_token: "rt", scope: "openid" }));
    }) as unknown as typeof fetch;

    await pollForToken(AUTH_BASE, DEVICE_CODE, CLIENT_ID, 5, {
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });

    expect(waits).toEqual([5000, 10000, 20000, 20000, 40000, 60000, 60000, 60000, 60000]);
  });

  test("the failure backoff never shortens a longer interval the server asked for", async () => {
    // slow_down x12 pushes the interval to 65 s; a failure must not pull it back to 60.
    const plan = [...Array<string>(12).fill("slow"), "fail", "ok"];
    const waits: number[] = [];
    let calls = 0;
    globalThis.fetch = mock(() => {
      const step = plan[calls++];
      if (step === "fail") return Promise.reject(bunReset());
      if (step === "slow") return Promise.resolve(jsonRes({ error: "slow_down" }, 400));
      return Promise.resolve(jsonRes({ access_token: "tok", refresh_token: "rt", scope: "openid" }));
    }) as unknown as typeof fetch;

    await pollForToken(AUTH_BASE, DEVICE_CODE, CLIENT_ID, 5, {
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });

    expect(waits.at(-2)).toBe(65000);
    expect(waits.at(-1)).toBe(65000);
  });

  test("a network failure during login keeps exit 7 and the --verbose hint", async () => {
    globalThis.fetch = mock(() => Promise.reject(bunReset())) as unknown as typeof fetch;

    const err = (await initiateDeviceFlow(AUTH_BASE, CLIENT_ID, "openid", fast).catch(
      (e: unknown) => e,
    )) as DeviceFlowError & { exitCode?: number; hint?: string };

    expect(err.exitCode).toBe(7);
    expect(err.hint).toContain("--verbose");
  });

  test("aborting the login still reads as a cancel, not a network error", async () => {
    const ctrl = new AbortController();
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("The operation was aborted.");
          e.name = "AbortError";
          reject(e);
        });
        ctrl.abort();
      });
    }) as unknown as typeof fetch;

    const err = (await pollForToken(AUTH_BASE, DEVICE_CODE, CLIENT_ID, 5, {
      ...fast,
      abortSignal: ctrl.signal,
    }).catch((e: unknown) => e)) as DeviceFlowError;

    expect(err).toBeInstanceOf(DeviceFlowError);
    expect(err.code).toBe("access_denied");
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
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(jsonRes({ access_token: "t", refresh_token: "r", scope: "openid" }));
    }) as unknown as typeof fetch;

    await refreshAccessToken(AUTH_BASE, "my_refresh", CLIENT_ID);
    expect(capturedBody).toContain("grant_type=refresh_token");
    expect(capturedBody).toContain("refresh_token=my_refresh");
    expect(capturedBody).toContain(`client_id=${CLIENT_ID}`);
  });

  test("sends tenant_id so the refreshed token stays bound to the active org", async () => {
    let capturedBody = "";
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(jsonRes({ access_token: "t", refresh_token: "r", scope: "openid" }));
    }) as unknown as typeof fetch;

    await refreshAccessToken(AUTH_BASE, "my_refresh", CLIENT_ID, "d7f6e5c4-1111-2222-3333-444455556666");
    expect(capturedBody).toContain("tenant_id=d7f6e5c4-1111-2222-3333-444455556666");
  });

  test("omits tenant_id when the profile has no org pinned", async () => {
    let capturedBody = "";
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(jsonRes({ access_token: "t", refresh_token: "r", scope: "openid" }));
    }) as unknown as typeof fetch;

    await refreshAccessToken(AUTH_BASE, "my_refresh", CLIENT_ID);
    expect(capturedBody).not.toContain("tenant_id");
  });

  test("throws DeviceFlowError on refresh failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("unauthorized", { status: 401 })),
    ) as unknown as typeof fetch;

    const err = await refreshAccessToken(AUTH_BASE, "bad_rt", CLIENT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("network");
  });

  test("attaches the HTTP status when the auth server rejects the refresh token", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('{"error":"invalid_grant"}', {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    const err = await refreshAccessToken(AUTH_BASE, "bad_rt", CLIENT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).status).toBe(400);
  });

  describe("connection resets (field report 2026-09-24)", () => {
    function bunReset(): Error & { code: string } {
      const e = new Error(
        "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      ) as Error & { code: string };
      e.code = "ECONNRESET";
      return e;
    }

    afterEach(() => setVerbose(false));

    test("a reset reads as plain words, without Bun's fetch() advice", async () => {
      globalThis.fetch = mock(() => Promise.reject(bunReset())) as unknown as typeof fetch;

      const err = (await refreshAccessToken(AUTH_BASE, "rt", CLIENT_ID).catch((e: unknown) => e)) as DeviceFlowError;

      expect(err).toBeInstanceOf(DeviceFlowError);
      expect(err.code).toBe("network");
      expect(err.status).toBeUndefined();
      expect(err.message).toContain("closed the connection before responding");
      expect(err.message).not.toContain("second argument to fetch");
    });

    test("makes one attempt: refreshSession owns the retry policy for the rotating token", async () => {
      let calls = 0;
      globalThis.fetch = mock(() => {
        calls++;
        return Promise.reject(bunReset());
      }) as unknown as typeof fetch;

      await refreshAccessToken(AUTH_BASE, "rt", CLIENT_ID).catch(() => undefined);

      expect(calls).toBe(1);
    });

    test("--verbose logs the refresh request, never the refresh token or the new tokens", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(jsonRes({ access_token: "new-access-xyz", refresh_token: "new-refresh-xyz", scope: "openid" })),
      ) as unknown as typeof fetch;
      const lines: string[] = [];
      setVerbose(true, (l) => lines.push(l));

      await refreshAccessToken(AUTH_BASE, "old-refresh-secret", CLIENT_ID);

      const text = lines.join("\n");
      expect(text).toContain("POST ");
      expect(text).toContain("/oauth/token");
      expect(text).not.toContain("old-refresh-secret");
      expect(text).not.toContain("new-access-xyz");
      expect(text).not.toContain("new-refresh-xyz");
    });
  });

  test("leaves status undefined on a genuine network failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    ) as unknown as typeof fetch;

    const err = await refreshAccessToken(AUTH_BASE, "rt", CLIENT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).status).toBeUndefined();
  });
});
