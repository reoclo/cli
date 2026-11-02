// tests/unit/commands/logout.test.ts
//
// `reoclo logout` must remove only what the profile's login stored. The OS
// keyring is shared by every config directory on the machine, so a profile
// kept in config.json must never reach it: the auth-lifecycle integration test
// logged out of a temp-config "default" profile and deleted the developer's
// real keyring token. The keyring here is an in-memory stand-in.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { endServerSession, registerLogout } from "../../../src/commands/logout";
import { withKeyringStore, type TokenStore } from "../../../src/config/token-store";
import { MemoryStore } from "../../../src/config/keyring/memory";

let tmp: string;
let out: string[];
let err: string[];
const realLog = console.log;
const realErrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "logout-"));
  process.env.REOCLO_CONFIG_DIR = tmp;
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  delete process.env.REOCLO_PROFILE;
  out = [];
  err = [];
  console.log = (...args: unknown[]) => { out.push(args.join(" ")); };
  process.stderr.write = (chunk: unknown): boolean => { err.push(String(chunk)); return true; };
});

afterEach(() => {
  console.log = realLog;
  process.stderr.write = realErrWrite;
  delete process.env.REOCLO_CONFIG_DIR;
  delete process.env.REOCLO_CACHE_DIR;
});

const untouchableKeyring: TokenStore = {
  kind: "keyring",
  get: () => Promise.reject(new Error("keyring read")),
  set: () => Promise.reject(new Error("keyring write")),
  delete: () => Promise.reject(new Error("keyring delete")),
};

function profile(overrides: Record<string, unknown> = {}) {
  return {
    api_url: "https://api.reoclo.com",
    token_type: "automation",
    tenant_id: "t-home",
    tenant_slug: "home",
    user_email: "dev@example.com",
    saved_at: "2026-01-01T00:00:00Z",
    auth_kind: "oauth",
    ...overrides,
  };
}

function seed(profiles: Record<string, unknown>): void {
  writeFileSync(join(tmp, "config.json"), JSON.stringify({ active_profile: "default", profiles }));
}

function savedProfiles(): Record<string, unknown> {
  const path = join(tmp, "config.json");
  if (!existsSync(path)) return {};
  return (JSON.parse(readFileSync(path, "utf8")) as { profiles: Record<string, unknown> }).profiles;
}

async function runLogout(
  args: string[],
  keyring: TokenStore | null,
  endSession: (name: string) => Promise<string | null> = () => Promise.resolve(null),
): Promise<string[]> {
  const ended: string[] = [];
  const program = new Command();
  program.name("reoclo").exitOverride();
  program.option("--profile <name>", "use a named profile");
  registerLogout(program, {
    endSession: (name) => {
      ended.push(name);
      return endSession(name);
    },
  });
  await withKeyringStore(keyring, () => program.parseAsync(["node", "reoclo", "logout", ...args]));
  return ended;
}

describe("reoclo logout", () => {
  test("a config-file profile ends its session and is removed without touching the keyring", async () => {
    seed({ default: profile({ token: "tok" }), other: profile({ token: "tok-2" }) });

    const ended = await runLogout([], untouchableKeyring);

    expect(ended).toEqual(["default"]);
    expect(Object.keys(savedProfiles())).toEqual(["other"]);
    expect(out.join("\n")).toContain("logged out of 'default'");
  });

  test("a keyring profile removes its access token and every refresh-token key, nothing else", async () => {
    seed({
      default: profile({ token_ref: "keyring:reoclo-default", refresh_token_ref: "reoclo-default-refresh" }),
      staging: profile({ token_ref: "keyring:reoclo-staging", refresh_token_ref: "staging-refresh" }),
    });
    const keyring = new MemoryStore();
    for (const key of ["default", "default-refresh", "reoclo-default-refresh", "staging", "staging-refresh"]) {
      await keyring.set(key, `v-${key}`);
    }

    await runLogout([], keyring);

    for (const key of ["default", "default-refresh", "reoclo-default-refresh"]) {
      expect(await keyring.get(key)).toBeNull();
    }
    expect(await keyring.get("staging")).toBe("v-staging");
    expect(await keyring.get("staging-refresh")).toBe("v-staging-refresh");
    expect(Object.keys(savedProfiles())).toEqual(["staging"]);
  });

  test("a session the server could not end still removes local credentials, with a warning", async () => {
    seed({ default: profile({ token_ref: "keyring:reoclo-default", refresh_token_ref: "default-refresh" }) });
    const keyring = new MemoryStore();
    await keyring.set("default", "tok");
    await keyring.set("default-refresh", "rt");

    await runLogout([], keyring, () => Promise.resolve("network down"));

    expect(err.join("")).toContain("could not end the session on the server (network down)");
    expect(await keyring.get("default")).toBeNull();
    expect(await keyring.get("default-refresh")).toBeNull();
    expect(savedProfiles()).toEqual({});
  });

  test("a non-OAuth profile is not sent to the server", async () => {
    seed({ default: profile({ auth_kind: "api-key", token: "rk_t_x" }) });

    const ended = await runLogout([], untouchableKeyring);

    expect(ended).toEqual([]);
    expect(savedProfiles()).toEqual({});
  });

  test("an unknown profile changes nothing", async () => {
    seed({ default: profile({ token: "tok" }) });

    const ended = await runLogout(["--profile", "ghost"], untouchableKeyring);

    expect(ended).toEqual([]);
    expect(Object.keys(savedProfiles())).toEqual(["default"]);
    expect(out.join("\n")).toContain("no profile 'ghost' to log out of");
  });
});

describe("endServerSession", () => {
  let api: ReturnType<typeof Bun.serve>;
  let requests: { method: string; path: string; auth: string | null }[];
  let status: number;

  beforeEach(() => {
    requests = [];
    status = 204;
    api = Bun.serve({
      port: 0,
      fetch(req) {
        requests.push({
          method: req.method,
          path: new URL(req.url).pathname,
          auth: req.headers.get("authorization"),
        });
        return status === 204
          ? new Response(null, { status })
          : Response.json({ detail: `status ${status}` }, { status });
      },
    });
  });

  afterEach(() => {
    void api.stop();
  });

  function jwtWithSid(sid: string): string {
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${part({ alg: "none" })}.${part({ sid, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  }

  function seedSessionProfile(token: string): void {
    seed({
      default: profile({
        api_url: `http://localhost:${api.port}`,
        token,
        access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
  }

  test("deletes the session named by the profile token's sid, with that token", async () => {
    const token = jwtWithSid("sess-1");
    seedSessionProfile(token);

    expect(await endServerSession("default")).toBeNull();
    expect(requests).toEqual([
      { method: "DELETE", path: "/mcp/auth/me/sessions/sess-1", auth: `Bearer ${token}` },
    ]);
  });

  test("a session the server no longer has counts as ended", async () => {
    seedSessionProfile(jwtWithSid("sess-1"));
    for (const code of [404, 409]) {
      status = code;
      expect(await endServerSession("default")).toBeNull();
    }
  });

  test("any other failure is reported", async () => {
    seedSessionProfile(jwtWithSid("sess-1"));
    status = 500;
    expect(await endServerSession("default")).not.toBeNull();
  });

  test("a token without a session id is reported and nothing is sent", async () => {
    seedSessionProfile("opaque-token");
    expect(await endServerSession("default")).toBe("the stored token carries no session id");
    expect(requests).toEqual([]);
  });
});
