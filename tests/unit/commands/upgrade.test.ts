import { describe, expect, test, mock, afterEach } from "bun:test";
import { detectInstallMethod, resolveLatestVersion } from "../../../src/commands/upgrade";

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

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun types expect().rejects.toThrow() as void but it is a Promise at runtime; await is required to settle the rejection before afterEach cleanup
    await expect(resolveLatestVersion("nightly")).rejects.toThrow(/unknown channel: nightly/);
  });

  test("stable HTTP error → throws with status", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("not found", { status: 404 })),
    ) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun types expect().rejects.toThrow() as void but it is a Promise at runtime; await is required to settle the rejection before afterEach cleanup
    await expect(resolveLatestVersion("stable")).rejects.toThrow(/HTTP 404/);
  });

  test("beta with no prereleases → throws", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse([{ tag_name: "v0.19.0", prerelease: false }])),
    ) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun types expect().rejects.toThrow() as void but it is a Promise at runtime; await is required to settle the rejection before afterEach cleanup
    await expect(resolveLatestVersion("beta")).rejects.toThrow(/no prerelease found/);
  });

  test("stable missing tag_name → throws", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse({}))) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun types expect().rejects.toThrow() as void but it is a Promise at runtime; await is required to settle the rejection before afterEach cleanup
    await expect(resolveLatestVersion("stable")).rejects.toThrow(/missing tag_name/);
  });
});

describe("detectInstallMethod — path patterns (Layer A)", () => {
  // Pass an empty context so Layer B (marker files) never matches in these
  // tests — exercises ONLY the path-substring fallback.
  const NO_MARKERS = { fileExists: (_p: string) => false, readFile: (_p: string) => null };

  test("Apple Silicon brew /opt/homebrew/Cellar/ → homebrew", () => {
    expect(
      detectInstallMethod("/opt/homebrew/Cellar/reoclo/0.36.1/bin/reoclo", NO_MARKERS),
    ).toBe("homebrew");
  });

  test("Intel brew /usr/local/Cellar/ → homebrew", () => {
    expect(
      detectInstallMethod("/usr/local/Cellar/reoclo/0.36.1/bin/reoclo", NO_MARKERS),
    ).toBe("homebrew");
  });

  test("linuxbrew → homebrew", () => {
    expect(
      detectInstallMethod(
        "/home/linuxbrew/.linuxbrew/Cellar/reoclo/0.36.1/bin/reoclo",
        NO_MARKERS,
      ),
    ).toBe("homebrew");
  });

  test("npm global node_modules → npm", () => {
    expect(
      detectInstallMethod(
        "/usr/local/lib/node_modules/@reoclo/cli/dist/reoclo",
        NO_MARKERS,
      ),
    ).toBe("npm");
  });

  test("pnpm global → pnpm (must beat node_modules)", () => {
    expect(
      detectInstallMethod(
        "/Users/me/.local/share/pnpm/global/5/node_modules/@reoclo/cli/dist/reoclo",
        NO_MARKERS,
      ),
    ).toBe("pnpm");
  });

  test("yarn global → yarn (must beat node_modules)", () => {
    expect(
      detectInstallMethod(
        "/Users/me/.config/yarn/global/node_modules/@reoclo/cli/dist/reoclo",
        NO_MARKERS,
      ),
    ).toBe("yarn");
  });

  test("mise install → mise", () => {
    expect(
      detectInstallMethod(
        "/Users/me/.local/share/mise/installs/reoclo/0.36.1/bin/reoclo",
        NO_MARKERS,
      ),
    ).toBe("mise");
  });

  test("asdf install → asdf", () => {
    expect(
      detectInstallMethod("/Users/me/.asdf/installs/reoclo/0.36.1/bin/reoclo", NO_MARKERS),
    ).toBe("asdf");
  });

  test("/usr/local/bin/reoclo → raw", () => {
    expect(detectInstallMethod("/usr/local/bin/reoclo", NO_MARKERS)).toBe("raw");
  });

  test("/opt/tools/reoclo (arbitrary dir) → raw", () => {
    expect(detectInstallMethod("/opt/tools/reoclo", NO_MARKERS)).toBe("raw");
  });

  test("misleading path with 'homebrew' substring but no marker → raw", () => {
    // A raw binary in a folder named after the project shouldn't be
    // mistaken for a brew install. With NO_MARKERS injected, the path
    // pattern is the only signal — and we anchor it on /Cellar/, /opt/
    // homebrew/, /linuxbrew/ rather than bare "homebrew".
    expect(
      detectInstallMethod("/Users/me/projects/homebrew-tap-experiments/reoclo", NO_MARKERS),
    ).toBe("raw");
  });
});

describe("detectInstallMethod — marker files (Layer B)", () => {
  test("INSTALL_RECEIPT.json in any parent → homebrew (even if path doesn't match)", () => {
    const result = detectInstallMethod("/some/weird/path/bin/reoclo", {
      fileExists: (p: string) => p === "/some/weird/path/INSTALL_RECEIPT.json",
      readFile: (_p: string) => null,
    });
    expect(result).toBe("homebrew");
  });

  test("package.json with name=@reoclo/cli + pnpm path → pnpm", () => {
    const result = detectInstallMethod(
      "/Users/me/.local/share/pnpm/global/5/node_modules/@reoclo/cli/dist/reoclo",
      {
        fileExists: (p: string) => p.endsWith("/@reoclo/cli/package.json"),
        readFile: (p: string) =>
          p.endsWith("/@reoclo/cli/package.json") ? '{"name":"@reoclo/cli"}' : null,
      },
    );
    expect(result).toBe("pnpm");
  });

  test("package.json with name=@reoclo/cli + generic node_modules path → npm", () => {
    const result = detectInstallMethod(
      "/usr/local/lib/node_modules/@reoclo/cli/dist/reoclo",
      {
        fileExists: (p: string) => p.endsWith("/@reoclo/cli/package.json"),
        readFile: (_p: string) => '{"name":"@reoclo/cli"}',
      },
    );
    expect(result).toBe("npm");
  });

  test("package.json with a different name → ignored, falls through to path", () => {
    const result = detectInstallMethod("/opt/tools/reoclo", {
      fileExists: (p: string) => p === "/opt/tools/package.json",
      readFile: (_p: string) => '{"name":"some-other-pkg"}',
    });
    expect(result).toBe("raw");
  });

  test("malformed package.json → ignored, falls through to path", () => {
    const result = detectInstallMethod("/opt/tools/reoclo", {
      fileExists: (p: string) => p === "/opt/tools/package.json",
      readFile: (_p: string) => "{ not valid json",
    });
    expect(result).toBe("raw");
  });
});
