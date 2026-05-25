// tests/unit/auth/omega-mcp-store.test.ts
//
// Unit tests for the omega-mcp token store — a focused, single-purpose file
// at ${configDir()}/omega-mcp.json that the omega-mcp Docker container
// mounts read-write for refresh.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  omegaMcpTokenPath,
  readOmegaMcpTokens,
  writeOmegaMcpTokens,
  type OmegaMcpTokenFile,
} from "../../../src/auth/omega-mcp-store";

let dir: string;
const prevEnv = process.env["REOCLO_CONFIG_DIR"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reoclo-omega-mcp-store-"));
  process.env["REOCLO_CONFIG_DIR"] = dir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env["REOCLO_CONFIG_DIR"];
  else process.env["REOCLO_CONFIG_DIR"] = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("omegaMcpTokenPath", () => {
  it("resolves to omega-mcp.json inside the config dir", () => {
    const path = omegaMcpTokenPath();
    expect(path).toBe(join(dir, "omega-mcp.json"));
  });
});

describe("writeOmegaMcpTokens", () => {
  it("creates the file with mode 0600", async () => {
    const tokens: OmegaMcpTokenFile = {
      access_token: "atk-1",
      refresh_token: "rtk-1",
      expires_at: "2026-12-31T00:00:00Z",
      api_url: "https://api.reoclo.com",
      auth_url: "https://auth.reoclo.com",
      client_id: "reoclo-omega-mcp",
      scope: "mcp:omega",
    };
    await writeOmegaMcpTokens(tokens);

    expect(existsSync(omegaMcpTokenPath())).toBe(true);

    if (process.platform !== "win32") {
      const stat = statSync(omegaMcpTokenPath());
      // 0o600 = owner read/write only — refuse to leak the refresh token to
      // group/other users via a permissive umask.
      // eslint-disable-next-line no-bitwise
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("creates the parent config dir if missing", async () => {
    // Force a not-yet-created subdirectory as the config dir
    const nested = join(dir, "nested", "configs");
    process.env["REOCLO_CONFIG_DIR"] = nested;
    const tokens: OmegaMcpTokenFile = {
      access_token: "a",
      refresh_token: "r",
      expires_at: "2026-01-01T00:00:00Z",
      api_url: "https://api",
      auth_url: "https://auth",
      client_id: "reoclo-omega-mcp",
      scope: "mcp:omega",
    };
    await writeOmegaMcpTokens(tokens);
    expect(existsSync(join(nested, "omega-mcp.json"))).toBe(true);
  });

  it("overwrites an existing file (refresh path)", async () => {
    const first: OmegaMcpTokenFile = {
      access_token: "a1",
      refresh_token: "r1",
      expires_at: "2026-01-01T00:00:00Z",
      api_url: "https://api",
      auth_url: "https://auth",
      client_id: "reoclo-omega-mcp",
      scope: "mcp:omega",
    };
    await writeOmegaMcpTokens(first);

    const second: OmegaMcpTokenFile = { ...first, access_token: "a2", refresh_token: "r2" };
    await writeOmegaMcpTokens(second);

    const read = await readOmegaMcpTokens();
    expect(read?.access_token).toBe("a2");
    expect(read?.refresh_token).toBe("r2");
  });
});

describe("readOmegaMcpTokens", () => {
  it("returns null when the file is missing", async () => {
    expect(await readOmegaMcpTokens()).toBeNull();
  });

  it("round-trips through writeOmegaMcpTokens", async () => {
    const tokens: OmegaMcpTokenFile = {
      access_token: "atk",
      refresh_token: "rtk",
      expires_at: "2026-12-31T00:00:00Z",
      api_url: "https://api.reoclo.com",
      auth_url: "https://auth.reoclo.com",
      client_id: "reoclo-omega-mcp",
      scope: "mcp:omega",
    };
    await writeOmegaMcpTokens(tokens);
    const read = await readOmegaMcpTokens();
    expect(read).toEqual(tokens);
  });
});
