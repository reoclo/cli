import { describe, expect, test, mock, afterEach } from "bun:test";
import { resolveLatestVersion } from "../../../src/commands/upgrade";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveLatestVersion", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("stable channel → fetches /releases/latest and returns tag_name", async () => {
    let calledUrl = "";
    globalThis.fetch = mock((url: string) => {
      calledUrl = url;
      return Promise.resolve(jsonResponse({ tag_name: "v0.19.0", prerelease: false }));
    }) as unknown as typeof fetch;

    const tag = await resolveLatestVersion("stable");
    expect(tag).toBe("v0.19.0");
    expect(calledUrl).toBe("https://api.github.com/repos/reoclo/cli/releases/latest");
  });

  test("beta channel → fetches releases list and returns first prerelease tag", async () => {
    let calledUrl = "";
    globalThis.fetch = mock((url: string) => {
      calledUrl = url;
      return Promise.resolve(
        jsonResponse([
          { tag_name: "v0.19.0", prerelease: false },
          { tag_name: "v0.20.0-beta.2", prerelease: true },
          { tag_name: "v0.20.0-beta.1", prerelease: true },
        ]),
      );
    }) as unknown as typeof fetch;

    const tag = await resolveLatestVersion("beta");
    expect(tag).toBe("v0.20.0-beta.2");
    expect(calledUrl).toBe("https://api.github.com/repos/reoclo/cli/releases?per_page=10");
  });

  test("dev channel behaves the same as beta", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse([{ tag_name: "v0.20.0-rc.1", prerelease: true }])),
    ) as unknown as typeof fetch;

    const tag = await resolveLatestVersion("dev");
    expect(tag).toBe("v0.20.0-rc.1");
  });

  test("unknown channel → throws with a helpful message", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse({ tag_name: "v0.19.0", prerelease: false })),
    ) as unknown as typeof fetch;

    await expect(resolveLatestVersion("nightly")).rejects.toThrow(/unknown channel: nightly/);
  });

  test("stable HTTP error → throws with status", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("not found", { status: 404 })),
    ) as unknown as typeof fetch;

    await expect(resolveLatestVersion("stable")).rejects.toThrow(/HTTP 404/);
  });

  test("beta with no prereleases → throws", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse([{ tag_name: "v0.19.0", prerelease: false }])),
    ) as unknown as typeof fetch;

    await expect(resolveLatestVersion("beta")).rejects.toThrow(/no prerelease found/);
  });

  test("stable missing tag_name → throws", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse({}))) as unknown as typeof fetch;

    await expect(resolveLatestVersion("stable")).rejects.toThrow(/missing tag_name/);
  });
});
