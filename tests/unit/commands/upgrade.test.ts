import { describe, expect, test, mock, afterEach, beforeEach } from "bun:test";
import {
  delegatedUpgradeArgv,
  detectInstallMethod,
  managedUpgradeInstructions,
  resolveLatestVersion,
} from "../../../src/commands/upgrade";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const RELEASES_PAGE = "https://github.com/reoclo/cli/releases/latest";
const RELEASES_API = "https://api.github.com/repos/reoclo/cli/releases";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function stubFetch(respond: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return Promise.resolve().then(() => respond(call));
  }) as unknown as typeof fetch;
  return calls;
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function authHeader(call: FetchCall | undefined): string | undefined {
  return (call?.init?.headers as Record<string, string> | undefined)?.["Authorization"];
}

describe("resolveLatestVersion", () => {
  const originalFetch = globalThis.fetch;
  const originalGhToken = process.env["GH_TOKEN"];
  const originalGithubToken = process.env["GITHUB_TOKEN"];

  beforeEach(() => {
    delete process.env["GH_TOKEN"];
    delete process.env["GITHUB_TOKEN"];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalGhToken === undefined) delete process.env["GH_TOKEN"];
    else process.env["GH_TOKEN"] = originalGhToken;
    if (originalGithubToken === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = originalGithubToken;
  });

  test("stable reads the tag from the releases page and never calls the API", async () => {
    process.env["GH_TOKEN"] = "gh-secret";
    const calls = stubFetch(() => redirectTo("https://github.com/reoclo/cli/releases/tag/v0.98.0"));

    expect(await resolveLatestVersion("stable")).toBe("v0.98.0");
    expect(calls.map((c) => c.url)).toEqual([RELEASES_PAGE]);
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(authHeader(calls[0])).toBeUndefined();
  });

  test("stable falls back to the API when the releases page does not redirect to a tag", async () => {
    const calls = stubFetch(({ url }) =>
      url === RELEASES_PAGE
        ? new Response("unavailable", { status: 503 })
        : jsonResponse({ tag_name: "v0.19.0", prerelease: false }),
    );

    expect(await resolveLatestVersion("stable")).toBe("v0.19.0");
    expect(calls.map((c) => c.url)).toEqual([RELEASES_PAGE, `${RELEASES_API}/latest`]);
  });

  test("stable falls back to the API when the releases page request fails", async () => {
    const calls = stubFetch(({ url }) => {
      if (url === RELEASES_PAGE) throw new DOMException("timed out", "TimeoutError");
      return jsonResponse({ tag_name: "v0.19.0", prerelease: false });
    });

    expect(await resolveLatestVersion("stable")).toBe("v0.19.0");
    expect(calls.map((c) => c.url)).toEqual([RELEASES_PAGE, `${RELEASES_API}/latest`]);
  });

  test("beta sends GH_TOKEN in preference to GITHUB_TOKEN", async () => {
    process.env["GH_TOKEN"] = "gh-secret";
    process.env["GITHUB_TOKEN"] = "github-secret";
    const calls = stubFetch(() => jsonResponse([{ tag_name: "v0.20.0-rc.1", prerelease: true }]));

    await resolveLatestVersion("beta");
    expect(authHeader(calls[0])).toBe("Bearer gh-secret");
  });

  test("beta sends GITHUB_TOKEN when it is the only token", async () => {
    process.env["GITHUB_TOKEN"] = "github-secret";
    const calls = stubFetch(() => jsonResponse([{ tag_name: "v0.20.0-rc.1", prerelease: true }]));

    await resolveLatestVersion("beta");
    expect(authHeader(calls[0])).toBe("Bearer github-secret");
  });

  test("beta sends no Authorization header without a token", async () => {
    const calls = stubFetch(() => jsonResponse([{ tag_name: "v0.20.0-rc.1", prerelease: true }]));

    await resolveLatestVersion("beta");
    expect(calls).toHaveLength(1);
    expect(authHeader(calls[0])).toBeUndefined();
  });

  test("beta retries anonymously when GitHub rejects the token", async () => {
    process.env["GITHUB_TOKEN"] = "token-from-another-forge";
    const calls = stubFetch((call) =>
      authHeader(call)
        ? new Response("bad credentials", { status: 401 })
        : jsonResponse([{ tag_name: "v0.20.0-rc.1", prerelease: true }]),
    );

    expect(await resolveLatestVersion("beta")).toBe("v0.20.0-rc.1");
    expect(calls).toHaveLength(2);
    expect(authHeader(calls[1])).toBeUndefined();
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
    expect(detectInstallMethod("/opt/homebrew/Cellar/reoclo/0.36.1/bin/reoclo", NO_MARKERS)).toBe(
      "homebrew",
    );
  });

  test("Intel brew /usr/local/Cellar/ → homebrew", () => {
    expect(detectInstallMethod("/usr/local/Cellar/reoclo/0.36.1/bin/reoclo", NO_MARKERS)).toBe(
      "homebrew",
    );
  });

  test("linuxbrew → homebrew", () => {
    expect(
      detectInstallMethod("/home/linuxbrew/.linuxbrew/Cellar/reoclo/0.36.1/bin/reoclo", NO_MARKERS),
    ).toBe("homebrew");
  });

  test("npm global node_modules → npm", () => {
    expect(
      detectInstallMethod("/usr/local/lib/node_modules/@reoclo/cli/dist/reoclo", NO_MARKERS),
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
    const result = detectInstallMethod("/usr/local/lib/node_modules/@reoclo/cli/dist/reoclo", {
      fileExists: (p: string) => p.endsWith("/@reoclo/cli/package.json"),
      readFile: (_p: string) => '{"name":"@reoclo/cli"}',
    });
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

describe("delegatedUpgradeArgv (REO-380)", () => {
  test("homebrew delegates to brew upgrade on the tap", () => {
    expect(delegatedUpgradeArgv("homebrew", "0.81.0")).toEqual([
      "brew",
      "upgrade",
      "reoclo/tap/reoclo",
    ]);
  });

  test("npm, pnpm and yarn delegate with a pinned version", () => {
    expect(delegatedUpgradeArgv("npm", "0.81.0")).toEqual(["npm", "i", "-g", "@reoclo/cli@0.81.0"]);
    expect(delegatedUpgradeArgv("pnpm", "0.81.0")).toEqual([
      "pnpm",
      "add",
      "-g",
      "@reoclo/cli@0.81.0",
    ]);
    expect(delegatedUpgradeArgv("yarn", "0.81.0")).toEqual([
      "yarn",
      "global",
      "add",
      "@reoclo/cli@0.81.0",
    ]);
  });

  test("chained version managers and raw installs do not delegate", () => {
    expect(delegatedUpgradeArgv("mise", "0.81.0")).toBeNull();
    expect(delegatedUpgradeArgv("asdf", "0.81.0")).toBeNull();
    expect(delegatedUpgradeArgv("raw", "0.81.0")).toBeNull();
  });
});

describe("managedUpgradeInstructions (REO-380)", () => {
  test("homebrew instructions name the tap", () => {
    expect(managedUpgradeInstructions("homebrew", "0.81.0")).toEqual([
      "Installed via Homebrew. Upgrade with:",
      "  brew upgrade reoclo/tap/reoclo",
    ]);
  });

  test("mise instructions keep the chained install + use", () => {
    expect(managedUpgradeInstructions("mise", "0.81.0")).toEqual([
      "Installed via mise. Upgrade with:",
      "  mise install reoclo@0.81.0 && mise use -g reoclo@0.81.0",
    ]);
  });
});
