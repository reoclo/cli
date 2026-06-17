import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrap, defaultStreamsUrl } from "../../../src/client/bootstrap";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "boot-"));
  process.env.REOCLO_CONFIG_DIR = tmp;
  delete process.env.REOCLO_API_KEY;
  delete process.env.REOCLO_AUTOMATION_KEY;
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
