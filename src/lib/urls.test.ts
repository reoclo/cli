// Tests for cli/src/lib/urls.ts
// Run with: bun test

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

// Helper to reload the module with fresh env (bun caches imports, so we
// test the pure functions directly by reading the module's exports after
// temporarily mutating process.env).
//
// Since the module-level constants ROOT_DOMAIN and SCHEME are evaluated at
// import time, we test the exported functions' behaviour by importing once
// with the default env and separately exercising the override-key paths
// (which read process.env at call time via resolveUrl/resolveHost).

import {
  rootDomain,
  apiUrl,
  authUrl,
  streamsUrl,
  appUrl,
  gatewayUrl,
  directWsUrl,
  uptimeHost,
  supportEmail,
  appHost,
  deriveAuthFromApi,
} from "./urls.ts";

describe("urls (default reoclo.com)", () => {
  test("rootDomain returns reoclo.com by default", () => {
    // Module was imported without REOCLO_ROOT_DOMAIN set
    expect(rootDomain()).toBe("reoclo.com");
  });

  test("apiUrl defaults to https://api.reoclo.com", () => {
    expect(apiUrl()).toBe("https://api.reoclo.com");
  });

  test("authUrl defaults to https://auth.reoclo.com", () => {
    expect(authUrl()).toBe("https://auth.reoclo.com");
  });

  test("streamsUrl defaults to https://streams.reoclo.com", () => {
    expect(streamsUrl()).toBe("https://streams.reoclo.com");
  });

  test("appUrl defaults to https://app.reoclo.com", () => {
    expect(appUrl()).toBe("https://app.reoclo.com");
  });

  test("gatewayUrl defaults to https://gateway.reoclo.com", () => {
    expect(gatewayUrl()).toBe("https://gateway.reoclo.com");
  });

  test("supportEmail uses root domain", () => {
    expect(supportEmail()).toBe("support@reoclo.com");
  });

  test("appHost returns bare hostname", () => {
    expect(appHost()).toBe("app.reoclo.com");
  });
});

describe("urls — per-service env override wins (full URL)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved["REOCLO_API_URL"] = process.env["REOCLO_API_URL"];
    saved["REOCLO_AUTH_URL"] = process.env["REOCLO_AUTH_URL"];
    saved["REOCLO_STREAMS_URL"] = process.env["REOCLO_STREAMS_URL"];
    saved["REOCLO_APP_URL"] = process.env["REOCLO_APP_URL"];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("REOCLO_API_URL full URL override", () => {
    process.env["REOCLO_API_URL"] = "https://api.custom.example.com";
    expect(apiUrl()).toBe("https://api.custom.example.com");
  });

  test("REOCLO_API_URL full URL override with path", () => {
    process.env["REOCLO_API_URL"] = "https://api.custom.example.com/";
    expect(apiUrl("/v1/ping")).toBe("https://api.custom.example.com/v1/ping");
  });

  test("REOCLO_API_URL bare hostname override", () => {
    process.env["REOCLO_API_URL"] = "api.reoclo.test";
    expect(apiUrl()).toBe("https://api.reoclo.test");
  });

  test("REOCLO_AUTH_URL override", () => {
    process.env["REOCLO_AUTH_URL"] = "https://auth.staging.example.com";
    expect(authUrl()).toBe("https://auth.staging.example.com");
  });

  test("REOCLO_STREAMS_URL override", () => {
    process.env["REOCLO_STREAMS_URL"] = "https://streams.staging.example.com";
    expect(streamsUrl()).toBe("https://streams.staging.example.com");
  });

  test("REOCLO_APP_URL override affects appHost", () => {
    process.env["REOCLO_APP_URL"] = "https://app.reoclo.test";
    expect(appHost()).toBe("app.reoclo.test");
  });
});

describe("urls — directWsUrl converts scheme", () => {
  test("converts https to wss", () => {
    expect(directWsUrl()).toBe("wss://direct.reoclo.com");
  });
});

describe("urls — uptimeHost", () => {
  test("returns bare host by default", () => {
    expect(uptimeHost()).toBe("uptime.reoclo.com");
  });
});

describe("deriveAuthFromApi", () => {
  test("derives staging auth url from staging api url", () => {
    expect(deriveAuthFromApi("https://api.reoclo.dev")).toBe("https://auth.reoclo.dev");
  });

  test("derives prod auth url from prod api url", () => {
    expect(deriveAuthFromApi("https://api.reoclo.com")).toBe("https://auth.reoclo.com");
  });

  test("preserves http scheme for local dev", () => {
    expect(deriveAuthFromApi("http://api.reoclo.test")).toBe("http://auth.reoclo.test");
  });

  test("strips trailing path when deriving", () => {
    expect(deriveAuthFromApi("https://api.reoclo.dev/v1/ping")).toBe("https://auth.reoclo.dev");
  });

  test("returns null when host is not api.<root>", () => {
    expect(deriveAuthFromApi("https://reoclo.dev")).toBeNull();
    expect(deriveAuthFromApi("https://gateway.reoclo.dev")).toBeNull();
  });

  test("returns null for localhost / raw IP", () => {
    expect(deriveAuthFromApi("http://localhost:8000")).toBeNull();
    expect(deriveAuthFromApi("http://127.0.0.1:8000")).toBeNull();
  });

  test("returns null for malformed URL", () => {
    expect(deriveAuthFromApi("not a url")).toBeNull();
    expect(deriveAuthFromApi("")).toBeNull();
  });
});
