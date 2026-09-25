import { describe, expect, test } from "bun:test";
import { NetworkError } from "../../../src/client/errors";
import { sendWithRetry, type TransportOptions } from "../../../src/client/transport";

/**
 * sendWithRetry owns the transport layer under HttpClient and the tenant_switch
 * mint: one fetch per attempt, a retry when the connection fails before any
 * response arrives, and a NetworkError that says what failed in plain words.
 *
 * The retry exists because of a field failure (2026-09-24): on some networks,
 * Bun's TLS client gets its connection reset by Cloudflare's edge before any
 * response when the request carries a long bearer token. A fresh connection
 * usually gets through, so one command should not die on one reset.
 */

const URL_ = "https://api.example.com/mcp/auth/me";

/** The exact shape Bun 1.3.11 / 1.4.2 throws when the peer resets the socket. */
function bunReset(): Error & { code: string } {
  const e = new Error(
    "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
  ) as Error & { code: string };
  e.code = "ECONNRESET";
  return e;
}

function bunRefused(): Error & { code: string } {
  const e = new Error("Unable to connect. Is the computer able to access the url?") as Error & {
    code: string;
  };
  e.code = "ConnectionRefused";
  return e;
}

const noSleep = (): Promise<void> => Promise.resolve();

function opts(overrides: Partial<TransportOptions> = {}): TransportOptions {
  return { retries: 2, sleep: noSleep, ...overrides };
}

/** A fetch stub that rejects `failures` times, then answers 200. */
function flakyFetch(failures: number, error: () => Error = bunReset) {
  const calls: RequestInit[] = [];
  const impl = (_url: string, init: RequestInit): Promise<Response> => {
    calls.push(init);
    if (calls.length <= failures) return Promise.reject(error());
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  return { impl, calls };
}

describe("sendWithRetry", () => {
  test("a reset before any response is retried, and a later attempt's response is returned", async () => {
    const f = flakyFetch(2);
    const res = await sendWithRetry(URL_, { method: "GET" }, opts({ fetchImpl: f.impl }));
    expect(res.status).toBe(200);
    expect(f.calls.length).toBe(3);
  });

  test("gives up after retries + 1 attempts with a NetworkError that names the request", async () => {
    const f = flakyFetch(99);
    const err = (await sendWithRetry(URL_, { method: "GET" }, opts({ fetchImpl: f.impl })).catch(
      (e: unknown) => e,
    )) as NetworkError;
    expect(f.calls.length).toBe(3);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.exitCode).toBe(7);
    expect(err.message).toContain("GET");
    expect(err.message).toContain(URL_);
    expect(err.hint).toContain("3 attempts");
  });

  test("retries: 0 makes exactly one attempt", async () => {
    const f = flakyFetch(99);
    const err = await sendWithRetry(
      URL_,
      { method: "POST" },
      opts({ retries: 0, fetchImpl: f.impl }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(f.calls.length).toBe(1);
  });

  test("an HTTP error response is returned as-is, never retried", async () => {
    const calls: number[] = [];
    const impl = (): Promise<Response> => {
      calls.push(1);
      return Promise.resolve(new Response("boom", { status: 502 }));
    };
    const res = await sendWithRetry(URL_, { method: "GET" }, opts({ fetchImpl: impl }));
    expect(res.status).toBe(502);
    expect(calls.length).toBe(1);
  });

  test("backs off between attempts", async () => {
    const waits: number[] = [];
    const f = flakyFetch(2);
    await sendWithRetry(
      URL_,
      { method: "GET" },
      opts({
        fetchImpl: f.impl,
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      }),
    );
    expect(waits.length).toBe(2);
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[1]).toBeGreaterThan(waits[0]!);
  });

  test("a failed attempt's timeout is disarmed before the backoff sleep", async () => {
    // The timer must not outlive its attempt: aborting a controller nobody
    // uses is harmless today, and a trap for the next change.
    const signals: AbortSignal[] = [];
    const impl = (_url: string, init: RequestInit): Promise<Response> => {
      signals.push(init.signal!);
      return signals.length === 1
        ? Promise.reject(bunReset())
        : Promise.resolve(new Response("{}"));
    };
    await sendWithRetry(
      URL_,
      { method: "GET" },
      opts({ fetchImpl: impl, timeoutMs: 5, sleep: () => new Promise((r) => setTimeout(r, 30)) }),
    );
    expect(signals.length).toBe(2);
    expect(signals[0]!.aborted).toBe(false);
  });

  test("our own timeout is reported as a timeout and is NOT retried", async () => {
    const calls: number[] = [];
    // Never settles on its own; only the attempt's abort signal ends it.
    const impl = (_url: string, init: RequestInit): Promise<Response> => {
      calls.push(1);
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e = new Error("The operation was aborted.");
          e.name = "AbortError";
          reject(e);
        });
      });
    };
    const err = (await sendWithRetry(
      URL_,
      { method: "GET" },
      opts({ fetchImpl: impl, timeoutMs: 10 }),
    ).catch((e: unknown) => e)) as NetworkError;
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).toContain("timed out");
    expect(calls.length).toBe(1);
  });

  test("a reset reads as a closed connection, without Bun's fetch() advice", async () => {
    const f = flakyFetch(99);
    const err = (await sendWithRetry(
      URL_,
      { method: "GET" },
      opts({ retries: 0, fetchImpl: f.impl }),
    ).catch((e: unknown) => e)) as NetworkError;
    expect(err.message).toContain("closed the connection before responding");
    expect(err.message).not.toContain("verbose: true");
    expect(err.message).not.toContain("second argument to fetch");
  });

  test("a refused connection reads as could-not-connect", async () => {
    const f = flakyFetch(99, bunRefused);
    const err = (await sendWithRetry(
      URL_,
      { method: "GET" },
      opts({ retries: 0, fetchImpl: f.impl }),
    ).catch((e: unknown) => e)) as NetworkError;
    expect(err.message).toContain("could not connect");
  });

  test("the original error is kept as cause", async () => {
    const original = bunReset();
    const impl = (): Promise<Response> => Promise.reject(original);
    const err = (await sendWithRetry(
      URL_,
      { method: "GET" },
      opts({ retries: 0, fetchImpl: impl }),
    ).catch((e: unknown) => e)) as NetworkError;
    expect(err.cause).toBe(original);
  });

  test("a non-Error rejection is rethrown untouched and not retried", async () => {
    const calls: number[] = [];
    const impl = (): Promise<Response> => {
      calls.push(1);
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject("just a string");
    };
    const err = await sendWithRetry(URL_, { method: "GET" }, opts({ fetchImpl: impl })).catch(
      (e: unknown) => e,
    );
    expect(err).toBe("just a string");
    expect(calls.length).toBe(1);
  });
  test("the hint does not suggest --verbose when a logger is already on", async () => {
    const err = (await sendWithRetry(
      URL_,
      { method: "GET" },
      opts({ fetchImpl: flakyFetch(99).impl, log: () => undefined }),
    ).catch((e: unknown) => e)) as NetworkError;
    expect(err.hint).toBeDefined();
    expect(err.hint).not.toContain("--verbose");
  });
});

describe("sendWithRetry verbose log", () => {
  const TOKEN = "eyJhbGciOiJSUzI1NiJ9.secret-payload.signature";

  function run(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, retries = 2) {
    const lines: string[] = [];
    const p = sendWithRetry(
      URL_,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/json",
          Cookie: "sid=abc",
        },
      },
      opts({ retries, fetchImpl, log: (l) => lines.push(l) }),
    ).catch(() => undefined);
    return p.then(() => lines);
  }

  test("logs the request line and headers before sending, with credentials redacted", async () => {
    const lines = await run(flakyFetch(0).impl);
    const text = lines.join("\n");
    expect(text).toContain(`GET ${URL_}`);
    expect(text).toContain("Accept: application/json");
    expect(text).toContain("Authorization: Bearer [redacted]");
    expect(text).toContain("Cookie: [redacted]");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("secret-payload");
    expect(text).not.toContain("sid=abc");
  });

  test("logs the request body size, never its content", async () => {
    const lines: string[] = [];
    await sendWithRetry(
      URL_,
      { method: "POST", body: "grant_type=x&refresh_token=super-secret" },
      opts({ fetchImpl: flakyFetch(0).impl, log: (l) => lines.push(l) }),
    );
    const text = lines.join("\n");
    expect(text).toContain("body: 39 bytes");
    expect(text).not.toContain("super-secret");
  });

  test("logs the response status", async () => {
    const lines = await run(flakyFetch(0).impl);
    expect(lines.some((l) => /^< 200 GET /.test(l))).toBe(true);
  });

  test("logs each failed attempt, so a request with no response is still visible", async () => {
    const lines = await run(flakyFetch(99).impl);
    const failures = lines.filter((l) => l.includes("closed the connection before responding"));
    expect(failures.length).toBe(3);
    expect(lines.filter((l) => l.includes(`GET ${URL_}`)).length).toBeGreaterThanOrEqual(3);
  });

  test("logs nothing when no logger is given", async () => {
    // Guard against a stray console.* in the transport: it must stay silent
    // unless --verbose wired a logger in.
    const writes: string[] = [];
    const origErr = console.error;
    const origLog = console.log;
    const origWrite = process.stderr.write.bind(process.stderr);
    console.error = (...a: unknown[]) => writes.push(a.join(" "));
    console.log = (...a: unknown[]) => writes.push(a.join(" "));
    process.stderr.write = (chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      await sendWithRetry(URL_, { method: "GET" }, opts({ fetchImpl: flakyFetch(1).impl }));
    } finally {
      console.error = origErr;
      console.log = origLog;
      process.stderr.write = origWrite;
    }
    expect(writes).toEqual([]);
  });
});
