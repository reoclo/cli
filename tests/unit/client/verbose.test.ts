import { afterEach, describe, expect, mock, test } from "bun:test";
import { HttpClient } from "../../../src/client/http";
import { setVerbose, verboseLogger } from "../../../src/client/verbose";

/**
 * `--verbose` was declared ("log HTTP requests (tokens redacted)") but nothing
 * read it, so a request that died with no response left no trace. setVerbose()
 * is the one switch the root command flips; every HttpClient reads it at send
 * time.
 */
describe("--verbose request logging", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setVerbose(false);
  });

  test("off by default: no logger", () => {
    expect(verboseLogger()).toBeUndefined();
  });

  test("setVerbose(true) installs the given writer; setVerbose(false) removes it", () => {
    const lines: string[] = [];
    setVerbose(true, (l) => lines.push(l));
    verboseLogger()?.("hello");
    expect(lines).toEqual(["hello"]);

    setVerbose(false);
    expect(verboseLogger()).toBeUndefined();
  });

  test("an HttpClient built before --verbose was set still logs through it", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      ),
    ) as unknown as typeof fetch;
    const client = new HttpClient({ baseUrl: "https://api.example.com", token: "tok-abc" });

    const lines: string[] = [];
    setVerbose(true, (l) => lines.push(l));
    await client.get("/auth/me");

    const text = lines.join("\n");
    expect(text).toContain("> GET https://api.example.com");
    expect(text).toContain("< 200");
    expect(text).not.toContain("tok-abc");
  });
});
