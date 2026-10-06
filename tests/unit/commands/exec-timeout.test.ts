import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { HttpClient } from "../../../src/client/http";
import {
  DEFAULT_EXEC_TIMEOUT_SECONDS,
  execClientTimeoutMs,
  parseExecTimeoutSeconds,
} from "../../../src/commands/exec";

describe("parseExecTimeoutSeconds", () => {
  test("defaults to 600 when --timeout is absent", () => {
    expect(parseExecTimeoutSeconds(undefined)).toBe(DEFAULT_EXEC_TIMEOUT_SECONDS);
    expect(DEFAULT_EXEC_TIMEOUT_SECONDS).toBe(600);
  });

  test("parses a positive number of seconds", () => {
    expect(parseExecTimeoutSeconds("120")).toBe(120);
  });

  test.each(["abc", "0", "-5", ""])("rejects %p with a usage error", (raw) => {
    let caught: unknown;
    try {
      parseExecTimeoutSeconds(raw);
    } catch (e) {
      caught = e;
    }
    expect((caught as { exitCode?: number }).exitCode).toBe(2);
  });
});

describe("execClientTimeoutMs", () => {
  test("outlasts the command timeout by the relay margin", () => {
    expect(execClientTimeoutMs(600)).toBe(630_000);
    expect(execClientTimeoutMs(120)).toBe(150_000);
  });

  test("a 120 s command gets far more than the 30 s default request timeout", () => {
    expect(execClientTimeoutMs(120)).toBeGreaterThan(120_000);
  });
});

describe("HttpClient.withTimeout", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** The delay each request armed its abort timer with. */
  async function armedTimeouts(client: HttpClient): Promise<number[]> {
    globalThis.fetch = mock(() =>
      Promise.resolve(Response.json({ ok: true })),
    ) as unknown as typeof fetch;
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (ms !== undefined) delays.push(ms);
      return realSetTimeout(fn, ms);
    }) as unknown as typeof setTimeout);
    try {
      await client.post("/x", {});
    } finally {
      spy.mockRestore();
    }
    return delays;
  }

  test("the default client arms the 30 s request timeout", async () => {
    const c = new HttpClient({ baseUrl: "https://api.example.com", token: "t" });
    expect(await armedTimeouts(c)).toContain(30_000);
  });

  test("withTimeout arms the requested timeout instead", async () => {
    const c = new HttpClient({ baseUrl: "https://api.example.com", token: "t" }).withTimeout(
      execClientTimeoutMs(600),
    );
    const delays = await armedTimeouts(c);
    expect(delays).toContain(630_000);
    expect(delays).not.toContain(30_000);
  });
});
