import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BootstrapOptions, ResolvedContext } from "../../../src/client/bootstrap";
import { ApiError } from "../../../src/client/errors";
import { ApiDirectory, translateUpstream } from "../../../src/tunnels/directory";
import { ManagerError } from "../../../src/tunnels/manager";
import { rejectionOf } from "../../helpers/rejection";
import { seedTenantProfile } from "../../helpers/seed-profile";

const SERVER_ID = "00000000-0000-0000-0000-00000000bbbb";

let requests: string[];
let boots: BootstrapOptions[];
let tmp: string;
const saved: Record<string, string | undefined> = {};

function directory(respond: (path: string) => unknown): ApiDirectory {
  return new ApiDirectory((o) => {
    boots.push(o);
    return Promise.resolve({
      client: {
        get: (path: string) => {
          requests.push(path);
          return Promise.resolve(respond(path));
        },
      },
      tenantId: "t1",
      orgSlug: o.org,
      profileName: o.profile ?? "default",
    } as unknown as ResolvedContext);
  });
}

const servers = [
  { id: SERVER_ID, slug: "prod-1", name: "Production", hostname: "prod-1.example.com", connection_type: "runner", status: "online" },
  { id: "s2", slug: "bare", name: null, hostname: "bare.example.com", connection_type: "ssh", status: "offline" },
];

beforeEach(() => {
  requests = [];
  boots = [];
  tmp = mkdtempSync(join(tmpdir(), "reoclo-dir-"));
  for (const key of ["REOCLO_CONFIG_DIR", "REOCLO_CACHE_DIR", "REOCLO_MACHINE_TOKEN"]) saved[key] = process.env[key];
  process.env["REOCLO_CONFIG_DIR"] = tmp;
  process.env["REOCLO_CACHE_DIR"] = join(tmp, "cache");
  delete process.env["REOCLO_MACHINE_TOKEN"];
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("ApiDirectory", () => {
  it("lists the organizations of the profile without needing an org itself", async () => {
    const dir = directory(() => ({
      memberships: [{ id: "m1", tenant_id: "t1", tenant_slug: "acme", tenant_name: "Acme Inc", role: "tenant_admin" }],
    }));
    expect(await dir.orgs()).toEqual([{ id: "t1", slug: "acme", name: "Acme Inc" }]);
    expect(requests).toEqual(["/auth/me"]);
    expect(boots).toEqual([{ orgRequired: false, ignoreProjectOrg: true }]);
  });

  it("lists an organization's servers, naming a nameless one by its hostname", async () => {
    const dir = directory(() => servers);
    expect(await dir.servers("acme")).toEqual([
      { id: SERVER_ID, name: "Production", slug: "prod-1", connection_type: "runner", status: "online" },
      { id: "s2", name: "bare.example.com", slug: "bare", connection_type: "ssh", status: "offline" },
    ]);
    expect(requests).toEqual(["/tenants/t1/servers/"]);
    expect(boots[0]).toMatchObject({ org: "acme", ignoreProjectOrg: true });
  });

  it("reads the stored port scan from the server record", async () => {
    const dir = directory(() => ({
      port_scan: {
        listening_ports: [
          { port: 5432, protocol: "tcp", address: "127.0.0.1", process: "postgres", pid: 10, state: "LISTEN" },
          { port: 8080, protocol: "tcp", address: "0.0.0.0", process: null },
        ],
      },
    }));
    expect(await dir.ports("acme", SERVER_ID)).toEqual([
      { port: 5432, protocol: "tcp", bind_address: "127.0.0.1", process: "postgres" },
      { port: 8080, protocol: "tcp", bind_address: "0.0.0.0", process: "" },
    ]);
    expect(requests).toEqual([`/tenants/t1/servers/${SERVER_ID}`]);
  });

  it("answers an empty list for a server that was never scanned", async () => {
    expect(await directory(() => ({ port_scan: null })).ports("acme", SERVER_ID)).toEqual([]);
    expect(await directory(() => ({})).ports("acme", SERVER_ID)).toEqual([]);
  });

  it("finds a server by slug before reading its scan", async () => {
    const dir = directory((path) => (path.endsWith("/servers/") ? servers : { port_scan: { listening_ports: [] } }));
    await dir.ports("acme", "prod-1");
    expect(requests).toEqual(["/tenants/t1/servers/", `/tenants/t1/servers/${SERVER_ID}`]);
  });

  it("resolves a server name to the ids an ad-hoc tunnel needs", async () => {
    const dir = directory(() => servers);
    expect(await dir.resolve({ org: "acme", server: "prod-1", profile: "work" })).toEqual({
      org: "acme",
      tenant_id: "t1",
      profile: "work",
      server: "prod-1",
      server_id: SERVER_ID,
    });
    expect(boots[0]).toMatchObject({ org: "acme", profile: "work" });
  });

  it("looks up the display name when given an id", async () => {
    const dir = directory(() => servers);
    expect((await dir.resolve({ org: "acme", server: SERVER_ID })).server).toBe("Production");
  });

  it("turns a failure into a ManagerError", async () => {
    const dir = new ApiDirectory(() => Promise.reject(Object.assign(new Error("not authenticated"), { exitCode: 3 })));
    expect(await rejectionOf(dir.orgs())).toMatchObject({ code: "unauthorized", state: "needs_sign_in" });
  });
});

describe("signedIn", () => {
  it("is false with no profile and no environment credential", async () => {
    expect(await directory(() => ({})).signedIn()).toBe(false);
  });

  it("is true with a stored profile token", async () => {
    seedTenantProfile({ configDir: tmp, apiUrl: "http://127.0.0.1:1", token: "rk_t_x" });
    expect(await directory(() => ({})).signedIn()).toBe(true);
  });

  it("is true with an environment credential", async () => {
    process.env["REOCLO_MACHINE_TOKEN"] = "rk_m_abc";
    expect(await directory(() => ({})).signedIn()).toBe(true);
  });
});

describe("translateUpstream", () => {
  const code = (e: unknown): string => translateUpstream(e).code;

  it("maps sign-in, selection and lookup failures by exit code", () => {
    expect(translateUpstream(Object.assign(new Error("x"), { exitCode: 3 }))).toMatchObject({ code: "unauthorized", state: "needs_sign_in" });
    expect(code(Object.assign(new Error("x"), { exitCode: 4 }))).toBe("invalid");
    expect(code(Object.assign(new Error("x"), { exitCode: 5 }))).toBe("not_found");
    expect(translateUpstream(Object.assign(new Error("x"), { name: "ReauthRequiredError" })).state).toBe("needs_sign_in");
  });

  it("maps API statuses", () => {
    expect(code(new ApiError(401, "no", "/x"))).toBe("unauthorized");
    expect(translateUpstream(new ApiError(403, "no", "/x"))).toMatchObject({ code: "forbidden", state: "forbidden" });
    expect(code(new ApiError(404, "no", "/x"))).toBe("not_found");
    expect(code(new ApiError(500, "no", "/x"))).toBe("upstream");
  });

  it("keeps a ManagerError and wraps anything else", () => {
    const own = new ManagerError("conflict", "x");
    expect(translateUpstream(own)).toBe(own);
    expect(translateUpstream("boom")).toMatchObject({ code: "upstream", message: "boom" });
  });
});
