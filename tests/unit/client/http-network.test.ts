import { afterEach, describe, expect, mock, test } from "bun:test";
import { NetworkError } from "../../../src/client/errors";
import { HttpClient } from "../../../src/client/http";

/**
 * Regression tests for doFetch's network-error wrapping.
 *
 * The original guard only matched `e.name === "TypeError"`, which is what
 * Node/undici throws (`TypeError: fetch failed`). This CLI runs on Bun, whose
 * connection errors are `name: "Error"`, `code: "ConnectionRefused"` and are NOT
 * TypeErrors — so they escaped unwrapped and fell through to the generic exit 1,
 * surfacing Bun's raw message instead of ours.
 *
 * errors.test.ts asserts `new NetworkError(...).exitCode === 7`, but constructing
 * the class proves nothing about whether doFetch ever *reaches* it. These tests
 * exercise the wiring, with the error shapes Bun actually produces.
 */

/** Bun's connection-refused / DNS-failure shape, verified against Bun 1.3.x. Bun 1.4.x keeps the
 *  code and message but names it TypeError; the wrapping must not care either way. */
function bunConnectionError(): Error & { code: string } {
  const e = new Error("Unable to connect. Is the computer able to access the url?") as Error & {
    code: string;
  };
  e.code = "ConnectionRefused";
  return e;
}

function abortError(): Error {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

/** Node/undici's shape — still wrapped, so the CLI stays correct off-Bun. */
function undiciFetchFailed(): Error {
  const e = new TypeError("fetch failed");
  return e;
}

describe("HttpClient network error wrapping", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // No-op sleep: a failed GET now retries with backoff; the tests need not wait it out.
  const client = () =>
    new HttpClient({
      baseUrl: "https://api.example.com",
      token: "t",
      sleep: () => Promise.resolve(),
    });

  test("Bun connection-refused is wrapped as NetworkError (exit 7), not leaked as generic", async () => {
    globalThis.fetch = mock(() => Promise.reject(bunConnectionError())) as unknown as typeof fetch;

    const err = await client()
      .get("/x")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).exitCode).toBe(7);
  });

  test("Bun DNS failure is wrapped as NetworkError (same shape as connection-refused)", async () => {
    globalThis.fetch = mock(() => Promise.reject(bunConnectionError())) as unknown as typeof fetch;

    const err = await client()
      .get("/x")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).exitCode).toBe(7);
  });

  test("an AbortError raised by the runtime is still wrapped as NetworkError", async () => {
    globalThis.fetch = mock(() => Promise.reject(abortError())) as unknown as typeof fetch;

    const err = await client()
      .get("/x")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).exitCode).toBe(7);
  });

  test("Node/undici TypeError is still wrapped as NetworkError", async () => {
    globalThis.fetch = mock(() => Promise.reject(undiciFetchFailed())) as unknown as typeof fetch;

    const err = await client()
      .get("/x")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).exitCode).toBe(7);
  });

  test("the original error is preserved as cause, so the real fault is recoverable", async () => {
    const original = bunConnectionError();
    globalThis.fetch = mock(() => Promise.reject(original)) as unknown as typeof fetch;

    const err = (await client()
      .get("/x")
      .catch((e: unknown) => e)) as NetworkError;

    expect(err).toBeInstanceOf(NetworkError);
    expect(err.cause).toBe(original);
    expect(err.message).toContain("network error");
  });

  test("a non-Error rejection is rethrown untouched", async () => {
    // Rejecting with a non-Error is the whole point of this test — a runtime
    // could throw anything, and the `e instanceof Error` guard must not swallow
    // it into a NetworkError whose `.message` would be undefined.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    globalThis.fetch = mock(() => Promise.reject("just a string")) as unknown as typeof fetch;

    const err = await client()
      .get("/x")
      .catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(NetworkError);
    expect(err).toBe("just a string");
  });

  describe("connection resets (field report 2026-09-24)", () => {
    /** Bun's shape when the peer resets the socket before any response. */
    function bunReset(): Error & { code: string } {
      const e = new Error(
        "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      ) as Error & { code: string };
      e.code = "ECONNRESET";
      return e;
    }

    const fastClient = () =>
      new HttpClient({
        baseUrl: "https://api.example.com",
        token: "t",
        sleep: () => Promise.resolve(),
      });

    test("a GET that is reset before any response is retried on a fresh attempt", async () => {
      let calls = 0;
      globalThis.fetch = mock(() => {
        calls++;
        return calls === 1
          ? Promise.reject(bunReset())
          : Promise.resolve(
              new Response('{"ok":true}', {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
      }) as unknown as typeof fetch;

      const out = await fastClient().get<{ ok: boolean }>("/x");

      expect(out.ok).toBe(true);
      expect(calls).toBe(2);
    });

    test("a POST is never retried: the server may have acted on it", async () => {
      let calls = 0;
      globalThis.fetch = mock(() => {
        calls++;
        return Promise.reject(bunReset());
      }) as unknown as typeof fetch;

      const err = await fastClient()
        .post("/deploy", { a: 1 })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NetworkError);
      expect(calls).toBe(1);
    });

    for (const method of ["put", "patch", "del"] as const) {
      test(`${method.toUpperCase()} is never retried either`, async () => {
        let calls = 0;
        globalThis.fetch = mock(() => {
          calls++;
          return Promise.reject(bunReset());
        }) as unknown as typeof fetch;

        const c = fastClient();
        const err = await (method === "del" ? c.del("/x") : c[method]("/x", { a: 1 })).catch(
          (e: unknown) => e,
        );

        expect(err).toBeInstanceOf(NetworkError);
        expect(calls).toBe(1);
      });
    }

    test("our own timeout is honored per attempt and is NOT retried", async () => {
      let calls = 0;
      // Settles only when the attempt's signal aborts, like a server that never answers.
      globalThis.fetch = mock((_url: string, init?: RequestInit) => {
        calls++;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("The operation was aborted.");
            e.name = "AbortError";
            reject(e);
          });
        });
      }) as unknown as typeof fetch;
      const c = new HttpClient({
        baseUrl: "https://api.example.com",
        token: "t",
        timeoutMs: 10,
        sleep: () => Promise.resolve(),
      });

      const err = (await c.get("/x").catch((e: unknown) => e)) as NetworkError;

      expect(err).toBeInstanceOf(NetworkError);
      expect(err.message).toContain("timed out after 10 ms");
      expect(calls).toBe(1);
    });

    test("the final error names the method and URL and carries a hint", async () => {
      globalThis.fetch = mock(() => Promise.reject(bunReset())) as unknown as typeof fetch;

      const err = (await fastClient()
        .get("/auth/me")
        .catch((e: unknown) => e)) as NetworkError;

      expect(err).toBeInstanceOf(NetworkError);
      expect(err.exitCode).toBe(7);
      // The token picks the API prefix (/mcp for a bare token); assert around it.
      expect(err.message).toMatch(/GET https:\/\/api\.example\.com\/\S*auth\/me/);
      expect(err.message).not.toContain("second argument to fetch");
      expect(err.hint).toContain("--verbose");
    });

    test("with a logger, each request is logged before it is sent", async () => {
      globalThis.fetch = mock(() => Promise.reject(bunReset())) as unknown as typeof fetch;
      const lines: string[] = [];
      const c = new HttpClient({
        baseUrl: "https://api.example.com",
        token: "secret-token-value",
        sleep: () => Promise.resolve(),
        log: (l) => lines.push(l),
      });

      await c.get("/auth/me").catch(() => undefined);

      const text = lines.join("\n");
      expect(text).toMatch(/> GET https:\/\/api\.example\.com\/\S*auth\/me/);
      expect(text).toContain("Authorization: Bearer [redacted]");
      expect(text).not.toContain("secret-token-value");
    });
  });

  test("our own errors are NOT mislabelled as network — request building happens outside the try", async () => {
    // A circular body makes JSON.stringify throw a TypeError. That is a caller
    // bug, not a network fault. The old code built the request inside the try
    // AND matched on `name === "TypeError"`, so this surfaced as
    // "network error" with exit 7 — the same shape-matching flaw, inverted.
    // fetch must never even be reached here.
    const fetchSpy = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const err = await client()
      .post("/x", circular)
      .catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(NetworkError);
    expect(err).toBeInstanceOf(TypeError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
