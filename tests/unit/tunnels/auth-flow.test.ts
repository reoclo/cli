import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceLogin, type DeviceLoginTransport, type LoginFlowOptions } from "../../../src/auth/device-login";
import { DeviceFlowError } from "../../../src/auth/oauth-device";
import type { Me } from "../../../src/client/types";
import { loadConfig } from "../../../src/config/store";
import { apiUrl, authUrl, deriveAuthFromApi } from "../../../src/lib/urls";
import { createAuthFlow, type AuthEvent } from "../../../src/tunnels/auth-flow";
import { rejectionOf } from "../../helpers/rejection";

const init = {
  device_code: "dc-1",
  user_code: "WXYZ-9876",
  verification_uri: "https://auth.test/device",
  verification_uri_complete: "https://auth.test/device?user_code=WXYZ-9876",
  expires_in: 600,
  interval: 0,
};

const me = { id: "u1", email: "dev@example.com", tenant_id: "t1", tenant_slug: "acme", roles: [] } as Me;

describe("createAuthFlow", () => {
  let savedProfile: string | undefined;
  beforeEach(() => {
    savedProfile = process.env["REOCLO_PROFILE"];
    delete process.env["REOCLO_PROFILE"];
  });
  afterEach(() => {
    if (savedProfile === undefined) delete process.env["REOCLO_PROFILE"];
    else process.env["REOCLO_PROFILE"] = savedProfile;
  });

  function harness(): { calls: LoginFlowOptions[]; flow: ReturnType<typeof createAuthFlow> } {
    const calls: LoginFlowOptions[] = [];
    const flow = createAuthFlow((opts, hooks) => {
      calls.push(opts);
      hooks.onCode(init, init.verification_uri_complete);
      return Promise.resolve({ me, storeKind: "file", setActive: true });
    });
    return { calls, flow };
  }

  it("reports the code as a pending event, then success", async () => {
    const { calls, flow } = harness();
    const events: AuthEvent[] = [];
    const done = await flow.login({}, (e) => events.push(e));
    expect(events).toEqual([
      {
        status: "pending",
        user_code: "WXYZ-9876",
        verification_uri: "https://auth.test/device",
        verification_uri_complete: "https://auth.test/device?user_code=WXYZ-9876",
        expires_in: 600,
      },
    ]);
    expect(done).toEqual({ status: "success", email: "dev@example.com", profile: "default" });
    expect(calls[0]).toMatchObject({ profile: "default", source: "default", browser: false, api: apiUrl() });
    expect(calls[0]?.auth).toBe(deriveAuthFromApi(apiUrl()) ?? authUrl());
  });

  it("signs in to the requested profile, then $REOCLO_PROFILE, then default", async () => {
    const { calls, flow } = harness();
    process.env["REOCLO_PROFILE"] = "from-env";
    await flow.login({}, () => undefined);
    await flow.login({ profile: "  work " }, () => undefined);
    expect(calls.map((c) => [c.profile, c.source])).toEqual([
      ["from-env", "env"],
      ["work", "flag"],
    ]);
  });

  it("passes a failed sign-in through", async () => {
    const flow = createAuthFlow(() => Promise.reject(new DeviceFlowError("access_denied", "authorization cancelled by user")));
    expect(await rejectionOf(flow.login({}, () => undefined))).toMatchObject({ message: "authorization cancelled by user" });
  });
});

describe("deviceLogin", () => {
  let tmp: string;
  let api: ReturnType<typeof Bun.serve>;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reoclo-device-"));
    for (const key of ["REOCLO_CONFIG_DIR", "REOCLO_CACHE_DIR"]) saved[key] = process.env[key];
    process.env["REOCLO_CONFIG_DIR"] = tmp;
    process.env["REOCLO_CACHE_DIR"] = join(tmp, "cache");
    api = Bun.serve({
      port: 0,
      fetch(req) {
        return new URL(req.url).pathname.endsWith("/auth/me") ? Response.json(me) : new Response("{}", { status: 404 });
      },
    });
  });
  afterEach(async () => {
    await api.stop(true);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  const opts = (): LoginFlowOptions => ({
    profile: "default",
    source: "default",
    api: `http://127.0.0.1:${api.port}`,
    auth: "https://auth.test",
    keyring: false,
    browser: false,
  });

  it("shows the code before it polls, then saves the profile", async () => {
    const order: string[] = [];
    const transport: DeviceLoginTransport = {
      initiate: () => Promise.resolve(init),
      poll: (_auth, deviceCode, _client, _interval, o) => {
        order.push(`poll ${deviceCode}`);
        o?.onTick?.();
        return Promise.resolve({ access_token: "at-1", refresh_token: "rt-1", scope: "openid", expires_in: 3600 });
      },
    };
    const result = await deviceLogin(
      opts(),
      {
        onCode: (i, uri) => order.push(`code ${i.user_code} ${uri}`),
        onTick: () => order.push("tick"),
        onApproved: () => order.push("approved"),
      },
      transport,
    );
    expect(order).toEqual([
      "code WXYZ-9876 https://auth.test/device?user_code=WXYZ-9876",
      "poll dc-1",
      "tick",
      "approved",
    ]);
    expect(result).toMatchObject({ storeKind: "file", setActive: true, me: { email: "dev@example.com" } });
    const cfg = await loadConfig();
    expect(cfg.active_profile).toBe("default");
    expect(cfg.profiles["default"]).toMatchObject({
      auth_kind: "oauth",
      user_email: "dev@example.com",
      tenant_slug: "acme",
      token: "at-1",
      refresh_token: "rt-1",
      oauth_auth_url: "https://auth.test",
    });
  });

  it("builds the URL from the base when the server sends no complete one", async () => {
    let seen = "";
    const transport: DeviceLoginTransport = {
      initiate: () => Promise.resolve({ ...init, verification_uri_complete: undefined as unknown as string }),
      poll: () => Promise.resolve({ access_token: "at", refresh_token: "rt", scope: "openid" }),
    };
    await deviceLogin(opts(), { onCode: (_i, uri) => (seen = uri) }, transport);
    expect(seen).toBe("https://auth.test/device?user_code=WXYZ-9876");
  });

  it("saves nothing when the person denies the request", async () => {
    const transport: DeviceLoginTransport = {
      initiate: () => Promise.resolve(init),
      poll: () => Promise.reject(new DeviceFlowError("access_denied", "authorization cancelled by user")),
    };
    expect(await rejectionOf(deviceLogin(opts(), { onCode: () => undefined }, transport))).toMatchObject({
      code: "access_denied",
    });
    expect(Object.keys((await loadConfig()).profiles)).toEqual([]);
  });
});
