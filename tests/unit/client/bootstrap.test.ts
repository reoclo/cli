import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrap, defaultStreamsUrl, isEnvCredential } from "../../../src/client/bootstrap";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "boot-"));
  process.env.REOCLO_CONFIG_DIR = tmp;
  delete process.env.REOCLO_API_KEY;
  delete process.env.REOCLO_AUTOMATION_KEY;
  delete process.env.REOCLO_MACHINE_TOKEN;
  delete process.env.REOCLO_PROFILE;
  delete process.env.REOCLO_ORG;
  delete process.env.REOCLO_API_URL;
  delete process.env.REOCLO_STREAMS_URL;
});
afterEach(() => {
  delete process.env.REOCLO_CONFIG_DIR;
  delete process.env.REOCLO_API_URL;
  delete process.env.REOCLO_STREAMS_URL;
});

test("bootstrap throws with exitCode 3 when no auth source", async () => {
  let caught: unknown = null;
  try {
    await bootstrap();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as { exitCode?: number }).exitCode).toBe(3);
});

test("bootstrap honors --token flag (programmatic; OAuth bearer or test token)", async () => {
  const ctx = await bootstrap({ token: "oauth-access-token" });
  expect(ctx.token).toBe("oauth-access-token");
  expect(ctx.tokenType).toBe("tenant");
  expect(ctx.api).toBe("https://api.reoclo.com");
});

test("bootstrap auto-detects automation key by prefix", async () => {
  const ctx = await bootstrap({ token: "rk_a_robot" });
  expect(ctx.tokenType).toBe("automation");
});

test("bootstrap auto-detects rca_ automation key by prefix", async () => {
  const ctx = await bootstrap({ token: "rca_robot" });
  expect(ctx.tokenType).toBe("automation");
});

test("REOCLO_API_KEY env is no longer respected (tenant integration keys retired)", async () => {
  process.env.REOCLO_API_KEY = "rk_t_legacy";
  let caught: unknown = null;
  try {
    await bootstrap();
  } catch (e) {
    caught = e;
  }
  delete process.env.REOCLO_API_KEY;
  expect(caught).toBeInstanceOf(Error);
  expect((caught as { exitCode?: number }).exitCode).toBe(3);
});

test("hint is printed when REOCLO_API_KEY is set but no credential resolves", async () => {
  process.env.REOCLO_API_KEY = "rk_t_legacy";
  const writes: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown): boolean => { writes.push(String(chunk)); return true; };
  let caught: unknown = null;
  try {
    await bootstrap();
  } catch (e) {
    caught = e;
  } finally {
    process.stderr.write = orig;
    delete process.env.REOCLO_API_KEY;
  }
  expect((caught as { exitCode?: number }).exitCode).toBe(3);
  expect(writes.join("")).toContain("REOCLO_API_KEY is not read by the CLI");
});

test("no hint when REOCLO_API_KEY is unset and no credential resolves", async () => {
  const writes: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown): boolean => { writes.push(String(chunk)); return true; };
  try {
    await bootstrap();
  } catch {
    // expected exit 3
  } finally {
    process.stderr.write = orig;
  }
  expect(writes.join("")).not.toContain("REOCLO_API_KEY is not read");
});

test("REOCLO_AUTOMATION_KEY env is still respected", async () => {
  process.env.REOCLO_AUTOMATION_KEY = "rca_ciauto";
  try {
    const ctx = await bootstrap();
    expect(ctx.token).toBe("rca_ciauto");
    expect(ctx.tokenType).toBe("automation");
  } finally {
    delete process.env.REOCLO_AUTOMATION_KEY;
  }
});

test("a committed .reoclo is never read under an automation key (CI stays safe)", async () => {
  // A malformed .reoclo would throw if it were ever parsed — proving the file
  // is fully inert under automation-key auth, never breaking CI.
  const projectDir = mkdtempSync(join(tmpdir(), "proj-"));
  writeFileSync(join(projectDir, ".reoclo"), "{ this is : not json");
  const origCwd = process.cwd();
  process.chdir(projectDir);
  process.env.REOCLO_AUTOMATION_KEY = "rca_ciauto";
  try {
    const ctx = await bootstrap();
    expect(ctx.token).toBe("rca_ciauto");
    expect(ctx.tokenType).toBe("automation");
  } finally {
    process.chdir(origCwd);
    delete process.env.REOCLO_AUTOMATION_KEY;
  }
});

function seedConfig(dir: string, cfg: object): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
}

function profileRecord(token: string, slug: string) {
  return {
    api_url: "https://api.reoclo.com",
    token,
    token_type: "tenant",
    tenant_id: `t-${slug}`,
    tenant_slug: slug,
    user_email: "dev@example.com",
    saved_at: "2026-01-01T00:00:00Z",
  };
}

test("a .reoclo `profile` binding selects that profile", async () => {
  seedConfig(tmp, {
    active_profile: "default",
    profiles: { default: profileRecord("tok-default", "home"), work: profileRecord("tok-work", "work-org") },
  });
  const projectDir = mkdtempSync(join(tmpdir(), "proj-"));
  writeFileSync(join(projectDir, ".reoclo"), JSON.stringify({ profile: "work" }));
  const origCwd = process.cwd();
  process.chdir(projectDir);
  try {
    const ctx = await bootstrap();
    expect(ctx.profileName).toBe("work");
    expect(ctx.token).toBe("tok-work");
  } finally {
    process.chdir(origCwd);
  }
});

test("a .reoclo `profile` that doesn't exist fails loud (exit 3, names the profile)", async () => {
  seedConfig(tmp, { active_profile: "default", profiles: { default: profileRecord("tok", "home") } });
  const projectDir = mkdtempSync(join(tmpdir(), "proj-"));
  writeFileSync(join(projectDir, ".reoclo"), JSON.stringify({ profile: "ghost" }));
  const origCwd = process.cwd();
  process.chdir(projectDir);
  let caught: unknown = null;
  try {
    await bootstrap();
  } catch (e) {
    caught = e;
  } finally {
    process.chdir(origCwd);
  }
  expect((caught as { exitCode?: number })?.exitCode).toBe(3);
  expect((caught as Error).message).toMatch(/ghost/);
});

test("a .reoclo `profile` is ignored under an automation key", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "proj-"));
  writeFileSync(join(projectDir, ".reoclo"), JSON.stringify({ profile: "ghost" }));
  const origCwd = process.cwd();
  process.chdir(projectDir);
  process.env.REOCLO_AUTOMATION_KEY = "rca_ciauto";
  try {
    const ctx = await bootstrap();
    expect(ctx.token).toBe("rca_ciauto");
    expect(ctx.tokenType).toBe("automation");
  } finally {
    process.chdir(origCwd);
    delete process.env.REOCLO_AUTOMATION_KEY;
  }
});

// An automation key is tenant-bound and carries no profile. A leftover profile
// pointing at staging or localhost must not redirect CI traffic to that host.
test("a profile's api_url and streams_url are ignored under an automation key", async () => {
  seedConfig(tmp, {
    active_profile: "default",
    profiles: {
      default: {
        ...profileRecord("tok-default", "home"),
        api_url: "http://localhost:8000",
        streams_url: "http://localhost:8001",
      },
    },
  });
  process.env.REOCLO_AUTOMATION_KEY = "rca_ciauto";
  try {
    const ctx = await bootstrap();
    expect(ctx.token).toBe("rca_ciauto");
    expect(ctx.api).toBe("https://api.reoclo.com");
    expect(ctx.streamsUrl).toBe("https://streams.reoclo.com");
  } finally {
    delete process.env.REOCLO_AUTOMATION_KEY;
  }
});

// The counterpart to the test above, and the one that actually constrains the
// rule: suppression is for an *ambient* profile only. A profile the caller
// named must still select its endpoints, or `--profile staging` with a staging
// key silently reaches production.
test("a profile named with --profile still applies under an automation key", async () => {
  seedConfig(tmp, {
    active_profile: "default",
    profiles: {
      default: profileRecord("tok-default", "home"),
      staging: {
        ...profileRecord("tok-staging", "staging-org"),
        api_url: "https://api.reoclo.dev",
        streams_url: "https://streams.reoclo.dev",
      },
    },
  });
  process.env.REOCLO_AUTOMATION_KEY = "rca_ciauto";
  try {
    const ctx = await bootstrap({ profile: "staging" });
    expect(ctx.token).toBe("rca_ciauto");
    expect(ctx.api).toBe("https://api.reoclo.dev");
    expect(ctx.streamsUrl).toBe("https://streams.reoclo.dev");
  } finally {
    delete process.env.REOCLO_AUTOMATION_KEY;
  }
});

test("a profile named with $REOCLO_PROFILE still applies under an automation key", async () => {
  seedConfig(tmp, {
    active_profile: "default",
    profiles: {
      default: profileRecord("tok-default", "home"),
      staging: { ...profileRecord("tok-staging", "staging-org"), api_url: "https://api.reoclo.dev" },
    },
  });
  process.env.REOCLO_AUTOMATION_KEY = "rca_ciauto";
  process.env.REOCLO_PROFILE = "staging";
  try {
    expect((await bootstrap()).api).toBe("https://api.reoclo.dev");
  } finally {
    delete process.env.REOCLO_AUTOMATION_KEY;
    delete process.env.REOCLO_PROFILE;
  }
});

// Documents the escape hatch. Note this one does NOT guard the suppression
// rule: env has always short-circuited ahead of the profile, so it stays green
// with that change reverted.
test("an explicit REOCLO_API_URL still wins under an automation key", async () => {
  seedConfig(tmp, {
    active_profile: "default",
    profiles: { default: { ...profileRecord("tok-default", "home"), api_url: "http://localhost:8000" } },
  });
  process.env.REOCLO_AUTOMATION_KEY = "rca_ciauto";
  process.env.REOCLO_API_URL = "https://api.staging.reoclo.com";
  try {
    expect((await bootstrap()).api).toBe("https://api.staging.reoclo.com");
  } finally {
    delete process.env.REOCLO_AUTOMATION_KEY;
  }
});

// Regression for the merge-blocker finding: a machine can have BOTH a cached
// `reoclo login` OAuth profile AND REOCLO_AUTOMATION_KEY set. The automation
// key outranks the profile token in the precedence chain above, so it (not
// the profile) is the credential actually in use — and automation keys are
// single-tenant, exempt from the "no organization selected" requirement.
// Before the fix, orgSelectionError read profile.auth_kind directly and
// wrongly rejected this with exit 4.
test("REOCLO_AUTOMATION_KEY exempts the org requirement even with a cached OAuth profile", async () => {
  seedConfig(tmp, {
    active_profile: "default",
    profiles: {
      default: { ...profileRecord("tok-default", "home"), auth_kind: "oauth" },
    },
  });
  process.env.REOCLO_AUTOMATION_KEY = "rca_ciauto";
  try {
    const ctx = await bootstrap();
    expect(ctx.tokenType).toBe("automation");
    expect(ctx.token).toBe("rca_ciauto");
  } finally {
    delete process.env.REOCLO_AUTOMATION_KEY;
  }
});

// Regression for the credential-bleed finding: a machine can have BOTH a cached
// `reoclo login` OAuth profile (with a PAST access_token_expires_at) AND
// REOCLO_AUTOMATION_KEY set. The automation key outranks the profile token in
// the precedence chain, so it is the credential actually in use, and the
// profile's OAuth refresh must never fire on its behalf: proactively (it would
// swap the automation key for the cached OAuth profile's token, a different
// and possibly cross-tenant credential) or reactively (ctx.refresh must be
// undefined so a 401 surfaces instead of silently swapping).
test("an automation key suppresses the OAuth profile's refresh (proactive + ctx.refresh), even past-expiry", async () => {
  seedConfig(tmp, {
    active_profile: "default",
    profiles: {
      default: {
        ...profileRecord("tok-default", "home"),
        auth_kind: "oauth",
        refresh_token_ref: "keyring:default-refresh",
        access_token_expires_at: "2020-01-01T00:00:00Z", // well past
      },
    },
  });
  process.env.REOCLO_AUTOMATION_KEY = "rca_robot";
  try {
    const ctx = await bootstrap();
    expect(ctx.token).toBe("rca_robot");
    expect(ctx.tokenType).toBe("automation");
    expect(ctx.refresh).toBeUndefined();
  } finally {
    delete process.env.REOCLO_AUTOMATION_KEY;
  }
});

test("defaultStreamsUrl maps prod api → streams.reoclo.com", () => {
  expect(defaultStreamsUrl("https://api.reoclo.com")).toBe("https://streams.reoclo.com");
  expect(defaultStreamsUrl("https://api.reoclo.com/")).toBe("https://streams.reoclo.com");
});

test("defaultStreamsUrl falls through to the api host for dev/staging/localhost", () => {
  expect(defaultStreamsUrl("http://localhost:8000")).toBe("http://localhost:8000");
  expect(defaultStreamsUrl("https://api.staging.reoclo.com")).toBe(
    "https://api.staging.reoclo.com",
  );
  expect(defaultStreamsUrl("http://localhost:8000/")).toBe("http://localhost:8000");
});

test("bootstrap streamsUrl defaults to streams.reoclo.com for prod api", async () => {
  const ctx = await bootstrap({ token: "oauth-fake" });
  expect(ctx.api).toBe("https://api.reoclo.com");
  expect(ctx.streamsUrl).toBe("https://streams.reoclo.com");
});

test("bootstrap streamsUrl falls back to api when api is dev/localhost", async () => {
  const ctx = await bootstrap({ token: "oauth-fake", api: "http://localhost:8000" });
  expect(ctx.api).toBe("http://localhost:8000");
  expect(ctx.streamsUrl).toBe("http://localhost:8000");
});

test("REOCLO_STREAMS_URL env overrides the default", async () => {
  process.env.REOCLO_STREAMS_URL = "http://localhost:9000";
  const ctx = await bootstrap({ token: "oauth-fake" });
  expect(ctx.streamsUrl).toBe("http://localhost:9000");
});

test("--streams flag wins over env and defaults", async () => {
  process.env.REOCLO_STREAMS_URL = "http://localhost:9000";
  const ctx = await bootstrap({ token: "oauth-fake", streams: "http://localhost:9001" });
  expect(ctx.streamsUrl).toBe("http://localhost:9001");
});

// Light exposure test: no refresh mocking needed. The profile's own slug is
// passed as --org, so the Plan A org requirement is satisfied without a
// tenant-switch probe. access_token_expires_at is comfortably in the future,
// so the proactive refresh added in Task 3 never fires; this only asserts
// that a refreshable oauth profile's refresh callback and expiry are exposed
// on the resolved context for the MCP timer (Task 4) to consume.
test("bootstrap exposes ctx.refresh and ctx.accessTokenExpiresAt for a refreshable oauth profile", async () => {
  const futureExpiry = new Date(Date.now() + 3_600_000).toISOString();
  seedConfig(tmp, {
    active_profile: "default",
    profiles: {
      default: {
        ...profileRecord("tok-default", "home"),
        auth_kind: "oauth",
        refresh_token_ref: "keyring:default-refresh",
        access_token_expires_at: futureExpiry,
      },
    },
  });
  const ctx = await bootstrap({ org: "home" });
  expect(typeof ctx.refresh).toBe("function");
  expect(ctx.accessTokenExpiresAt).toBe(futureExpiry);
});

// --- REOCLO_MACHINE_TOKEN (rk_m_* machine-user credential) -----------------
//
// A machine token is, like REOCLO_AUTOMATION_KEY, an opaque env-provided
// credential with no profile of its own — it must suppress the same
// ambient-profile / .reoclo / refresh behavior automation keys do. Unlike an
// automation key it routes to the full /mcp surface (detectKeyType returns
// "tenant" for anything not rca_/rk_a_/rss_), so tokenType must come back
// "tenant", not "automation".

test("REOCLO_MACHINE_TOKEN is ingested and routes to the org surface", async () => {
  process.env.REOCLO_MACHINE_TOKEN = "rk_m_" + "a".repeat(48);
  const ctx = await bootstrap();
  expect(ctx.token).toBe(process.env.REOCLO_MACHINE_TOKEN);
  expect(ctx.tokenType).toBe("tenant"); // full /mcp surface, not automation
});

test("REOCLO_MACHINE_TOKEN outranks REOCLO_AUTOMATION_KEY (more specific credential)", async () => {
  process.env.REOCLO_MACHINE_TOKEN = "rk_m_machine";
  process.env.REOCLO_AUTOMATION_KEY = "rca_auto";
  const ctx = await bootstrap();
  expect(ctx.token).toBe("rk_m_machine");
  expect(ctx.tokenType).toBe("tenant");
});

test("--token flag still outranks REOCLO_MACHINE_TOKEN", async () => {
  process.env.REOCLO_MACHINE_TOKEN = "rk_m_machine";
  const ctx = await bootstrap({ token: "flag-token" });
  expect(ctx.token).toBe("flag-token");
});

test("REOCLO_MACHINE_TOKEN outranks a stored profile", async () => {
  seedConfig(tmp, {
    active_profile: "default",
    profiles: { default: profileRecord("tok-default", "home") },
  });
  process.env.REOCLO_MACHINE_TOKEN = "rk_m_machine";
  const ctx = await bootstrap();
  expect(ctx.token).toBe("rk_m_machine");
});

test("a committed .reoclo is never read under REOCLO_MACHINE_TOKEN (ambient credential stays inert)", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "proj-"));
  writeFileSync(join(projectDir, ".reoclo"), "{ this is : not json");
  const origCwd = process.cwd();
  process.chdir(projectDir);
  process.env.REOCLO_MACHINE_TOKEN = "rk_m_machine";
  try {
    const ctx = await bootstrap();
    expect(ctx.token).toBe("rk_m_machine");
    expect(ctx.tokenType).toBe("tenant");
  } finally {
    process.chdir(origCwd);
  }
});

test("a profile's api_url/streams_url are ignored under REOCLO_MACHINE_TOKEN (ambient profile suppressed)", async () => {
  seedConfig(tmp, {
    active_profile: "default",
    profiles: {
      default: {
        ...profileRecord("tok-default", "home"),
        api_url: "http://localhost:8000",
        streams_url: "http://localhost:8001",
      },
    },
  });
  process.env.REOCLO_MACHINE_TOKEN = "rk_m_machine";
  const ctx = await bootstrap();
  expect(ctx.token).toBe("rk_m_machine");
  expect(ctx.api).toBe("https://api.reoclo.com");
  expect(ctx.streamsUrl).toBe("https://streams.reoclo.com");
});

test("a profile named with --profile still applies its endpoints under REOCLO_MACHINE_TOKEN", async () => {
  seedConfig(tmp, {
    active_profile: "default",
    profiles: {
      default: profileRecord("tok-default", "home"),
      staging: {
        ...profileRecord("tok-staging", "staging-org"),
        api_url: "https://api.reoclo.dev",
        streams_url: "https://streams.reoclo.dev",
      },
    },
  });
  process.env.REOCLO_MACHINE_TOKEN = "rk_m_machine";
  const ctx = await bootstrap({ profile: "staging" });
  expect(ctx.token).toBe("rk_m_machine");
  expect(ctx.api).toBe("https://api.reoclo.dev");
  expect(ctx.streamsUrl).toBe("https://streams.reoclo.dev");
});

test("REOCLO_MACHINE_TOKEN exempts the org requirement even with a cached OAuth profile", async () => {
  seedConfig(tmp, {
    active_profile: "default",
    profiles: {
      default: { ...profileRecord("tok-default", "home"), auth_kind: "oauth" },
    },
  });
  process.env.REOCLO_MACHINE_TOKEN = "rk_m_machine";
  const ctx = await bootstrap();
  expect(ctx.tokenType).toBe("tenant");
  expect(ctx.token).toBe("rk_m_machine");
});

test("a machine token suppresses the OAuth profile's refresh (proactive + ctx.refresh), even past-expiry", async () => {
  seedConfig(tmp, {
    active_profile: "default",
    profiles: {
      default: {
        ...profileRecord("tok-default", "home"),
        auth_kind: "oauth",
        refresh_token_ref: "keyring:default-refresh",
        access_token_expires_at: "2020-01-01T00:00:00Z", // well past
      },
    },
  });
  process.env.REOCLO_MACHINE_TOKEN = "rk_m_machine";
  const ctx = await bootstrap();
  expect(ctx.token).toBe("rk_m_machine");
  expect(ctx.refresh).toBeUndefined();
});

// --- isEnvCredential -----------------------------------------------------
//
// Single source of truth for "is an ambient, env-provided credential
// (REOCLO_MACHINE_TOKEN or REOCLO_AUTOMATION_KEY) in use". Other call sites
// (index.ts's capability-gating + advisory hooks, update-check.ts's CI
// suppression) must go through this helper instead of re-deriving the
// predicate by hand — a bare REOCLO_AUTOMATION_KEY check at one of those
// sites was exactly the drift bug this helper exists to prevent.

test("isEnvCredential is false when neither env var is set", () => {
  expect(isEnvCredential()).toBe(false);
});

test("isEnvCredential is true when REOCLO_AUTOMATION_KEY is set", () => {
  process.env.REOCLO_AUTOMATION_KEY = "rca_x";
  try {
    expect(isEnvCredential()).toBe(true);
  } finally {
    delete process.env.REOCLO_AUTOMATION_KEY;
  }
});

test("isEnvCredential is true when REOCLO_MACHINE_TOKEN is set", () => {
  process.env.REOCLO_MACHINE_TOKEN = "rk_m_x";
  expect(isEnvCredential()).toBe(true);
});

test("isEnvCredential is true when both env vars are set", () => {
  process.env.REOCLO_MACHINE_TOKEN = "rk_m_x";
  process.env.REOCLO_AUTOMATION_KEY = "rca_x";
  try {
    expect(isEnvCredential()).toBe(true);
  } finally {
    delete process.env.REOCLO_AUTOMATION_KEY;
  }
});
