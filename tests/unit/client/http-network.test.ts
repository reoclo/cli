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

/** Bun's connection-refused / DNS-failure shape, verified against Bun 1.3.x. */
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

  const client = () => new HttpClient({ baseUrl: "https://api.example.com", token: "t" });

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

  test("AbortError (timeout) is still wrapped as NetworkError", async () => {
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
