import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import {
  registerDomains,
  planRows,
  pollPublish,
  publishDomainDns,
  buildAddBody,
  buildRedirect,
  parseRedirectCode,
  redirectLabel,
  assertRedirectOptions,
  lsRows,
  redirectPatchBody,
  accessPatchBody,
  assertAccessOptions,
} from "../../../src/commands/domains";
import { getCompletionSpec } from "../../../src/client/command-meta";
import type { HttpClient } from "../../../src/client/http";
import type { Domain } from "../../../src/client/types";

describe("domains dns/health/rm", () => {
  test("all three subcommands registered with withCompletion(domains)", () => {
    const program = new Command().name("reoclo");
    registerDomains(program);
    const domains = program.commands.find((c) => c.name() === "domains")!;
    const names = domains.commands.map((c) => c.name());
    for (const n of ["dns", "health", "rm"]) {
      expect(names).toContain(n);
    }
    for (const n of ["dns", "health", "rm"]) {
      const cmd = domains.commands.find((c) => c.name() === n)!;
      const spec = getCompletionSpec(cmd);
      expect(spec).toBeDefined();
      expect(spec!.args).toEqual([{ slot: 0, resource: "domains" }]);
    }
  });

  test("rm has --yes flag", () => {
    const program = new Command().name("reoclo");
    registerDomains(program);
    const rm = program.commands
      .find((c) => c.name() === "domains")!
      .commands.find((c) => c.name() === "rm")!;
    const longs = rm.options.map((o) => o.long);
    expect(longs).toContain("--yes");
  });
});

describe("domains dns --fix", () => {
  test("dns has --fix, --proxied and --yes flags", () => {
    const program = new Command().name("reoclo");
    registerDomains(program);
    const dns = program.commands.find((c) => c.name() === "domains")!.commands.find((c) => c.name() === "dns")!;
    const longs = dns.options.map((o) => o.long);
    for (const flag of ["--fix", "--proxied", "--yes"]) expect(longs).toContain(flag);
  });

  test("planRows flattens ops for the text table and drops keep rows", () => {
    const rows = planRows({
      credential_label: "cf", zone_name: "example.com", server_name: "core", plan_hash: "h", blocked_reason: null,
      ops: [
        { op: "update", record_type: "A", name: "a.example.com", current_content: "1.1.1.1", current_proxied: false, desired_content: "2.2.2.2", desired_proxied: false, reason: null },
        { op: "keep", record_type: "TXT", name: "t", current_content: "x", current_proxied: false, desired_content: "x", desired_proxied: false, reason: null },
        { op: "delete", record_type: "A", name: "a.example.com", current_content: "3.3.3.3", current_proxied: false, desired_content: null, desired_proxied: null, reason: null },
      ],
    });
    expect(rows).toEqual([
      { action: "update", type: "A", name: "a.example.com", current: "1.1.1.1", new: "2.2.2.2" },
      { action: "delete", type: "A", name: "a.example.com", current: "3.3.3.3", new: "-" },
    ]);
  });

  test("pollPublish returns once the publish leaves pending", async () => {
    const states = ["pending", "pending", "succeeded"];
    let i = 0;
    const fetch = () => Promise.resolve({ dns: { publish: { status: states[i++]!, applied: ["A x -> y (created)"], last_error: null } } });
    const out = await pollPublish(fetch, { attempts: 5, sleepMs: 0, sleep: async () => {} });
    expect(out?.status).toBe("succeeded");
    expect(i).toBe(3);
  });

  test("pollPublish gives up after attempts", async () => {
    const fetch = () => Promise.resolve({ dns: { publish: { status: "pending", applied: [], last_error: null } } });
    expect(await pollPublish(fetch, { attempts: 2, sleepMs: 0, sleep: async () => {} })).toBeNull();
  });
});

const DOMAINS = [
  { id: "d-root", fqdn: "example.com" },
  { id: "d-www", fqdn: "www.example.com" },
];
const APP = "11111111-1111-1111-1111-111111111111";
const SERVER = "22222222-2222-2222-2222-222222222222";

function fakeClient(domains: unknown = DOMAINS): { client: HttpClient; gets: string[] } {
  const gets: string[] = [];
  const client = {
    get: (path: string) => {
      gets.push(path);
      return Promise.resolve(domains);
    },
  } as unknown as HttpClient;
  return { client, gets };
}

function exitCodeOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { exitCode?: number }).exitCode;
  }
  return undefined;
}

async function asyncExitCodeOf(fn: () => Promise<unknown>): Promise<number | undefined> {
  try {
    await fn();
  } catch (e) {
    return (e as { exitCode?: number }).exitCode;
  }
  return undefined;
}

describe("redirect helpers", () => {
  test("parseRedirectCode defaults to 301 and rejects other codes with exit 2", () => {
    expect(parseRedirectCode(undefined)).toBe(301);
    expect(parseRedirectCode("308")).toBe(308);
    expect(exitCodeOf(() => parseRedirectCode("303"))).toBe(2);
  });

  test("a URL target passes through", () => {
    expect(buildRedirect("https://partner.example.org/x", DOMAINS, { keepPath: false, code: "307" })).toEqual({
      target_url: "https://partner.example.org/x",
      status_code: 307,
      keep_path: false,
    });
  });

  test("a domain target resolves by fqdn", () => {
    expect(buildRedirect("example.com", DOMAINS, { keepPath: true })).toEqual({
      target_domain_id: "d-root",
      target_path: null,
      status_code: 301,
      keep_path: true,
    });
  });

  test("lowercases the host and keeps the path", () => {
    expect(buildRedirect("Example.com/Blog", DOMAINS, { keepPath: true })).toMatchObject({
      target_domain_id: "d-root",
      target_path: "/Blog",
    });
  });

  test("an unknown domain exits 5 and suggests a URL", () => {
    let error: unknown;
    try {
      buildRedirect("nope.example.com", DOMAINS, { keepPath: true });
    } catch (e) {
      error = e;
    }
    expect((error as { exitCode: number }).exitCode).toBe(5);
    expect((error as Error).message).toContain("Use a full https:// URL");
  });

  test("redirectLabel", () => {
    expect(redirectLabel({ redirect: null }, DOMAINS)).toBe("-");
    expect(
      redirectLabel(
        { redirect: { target_domain_id: "d-root", target_url: null, target_path: "/blog", status_code: 301, keep_path: true } },
        DOMAINS,
      ),
    ).toBe("301 → example.com/blog");
    expect(
      redirectLabel(
        { redirect: { target_domain_id: null, target_url: "https://x.example.org", target_path: null, status_code: 308, keep_path: true } },
        DOMAINS,
      ),
    ).toBe("308 → https://x.example.org");
  });
});

describe("domains add", () => {
  test("add has the link and redirect flags", () => {
    const program = new Command().name("reoclo");
    registerDomains(program);
    const add = program.commands.find((c) => c.name() === "domains")!.commands.find((c) => c.name() === "add")!;
    const longs = add.options.map((o) => o.long);
    for (const flag of ["--app", "--server", "--port", "--redirect-to", "--code", "--no-keep-path"]) {
      expect(longs).toContain(flag);
    }
  });

  test("links to an app and a server", async () => {
    const { client } = fakeClient();
    const body = await buildAddBody(client, "T", "api.example.com", { app: APP, server: SERVER, port: "8080", keepPath: true });
    expect(body).toEqual({ fqdn: "api.example.com", application_id: APP, bound_server_id: SERVER, target_port: 8080 });
  });

  test("builds a redirect", async () => {
    const { client, gets } = fakeClient();
    const body = await buildAddBody(client, "T", "www.example.com", {
      app: APP,
      redirectTo: "example.com",
      code: "308",
      keepPath: true,
    });
    expect(gets).toEqual(["/tenants/T/domains/"]);
    expect(body).toEqual({
      fqdn: "www.example.com",
      application_id: APP,
      redirect: { target_domain_id: "d-root", target_path: null, status_code: 308, keep_path: true },
    });
  });

  test("misuse exits 2 before any request", async () => {
    const { client, gets } = fakeClient();
    expect(await asyncExitCodeOf(() => buildAddBody(client, "T", "a.example.com", { code: "301", keepPath: true }))).toBe(2);
    expect(await asyncExitCodeOf(() => buildAddBody(client, "T", "a.example.com", { keepPath: false }))).toBe(2);
    expect(await asyncExitCodeOf(() => buildAddBody(client, "T", "a.example.com", { redirectTo: "example.com", keepPath: true }))).toBe(2);
    expect(
      await asyncExitCodeOf(() =>
        buildAddBody(client, "T", "a.example.com", { app: APP, redirectTo: "example.com", port: "80", keepPath: true }),
      ),
    ).toBe(2);
    expect(gets).toEqual([]);
  });
});

describe("domains redirect", () => {
  test("registered with completion on the domain argument", () => {
    const program = new Command().name("reoclo");
    registerDomains(program);
    const cmd = program.commands.find((c) => c.name() === "domains")!.commands.find((c) => c.name() === "redirect")!;
    expect(getCompletionSpec(cmd)!.args).toEqual([{ slot: 0, resource: "domains" }]);
    const longs = cmd.options.map((o) => o.long);
    for (const flag of ["--to", "--code", "--no-keep-path", "--off"]) expect(longs).toContain(flag);
  });

  test("--to builds the redirect", () => {
    expect(redirectPatchBody({ to: "example.com/blog", keepPath: true }, DOMAINS)).toEqual({
      redirect: { target_domain_id: "d-root", target_path: "/blog", status_code: 301, keep_path: true },
    });
  });

  test("--off clears it", () => {
    expect(redirectPatchBody({ off: true, keepPath: true }, DOMAINS)).toEqual({ redirect: null });
  });

  test("misuse exits 2", () => {
    expect(exitCodeOf(() => assertRedirectOptions({ keepPath: true }))).toBe(2);
    expect(exitCodeOf(() => assertRedirectOptions({ to: "example.com", off: true, keepPath: true }))).toBe(2);
    expect(exitCodeOf(() => assertRedirectOptions({ off: true, code: "308", keepPath: true }))).toBe(2);
    expect(exitCodeOf(() => assertRedirectOptions({ off: true, keepPath: false }))).toBe(2);
  });
});

describe("domains ls", () => {
  test("lsRows keeps every field and adds redirects_to", () => {
    const list = [
      { id: "d-root", fqdn: "example.com", status: "active", application_id: "A", redirect: null },
      {
        id: "d-www",
        fqdn: "www.example.com",
        status: "active",
        application_id: "A",
        redirect: { target_domain_id: "d-root", target_url: null, target_path: null, status_code: 301, keep_path: true },
      },
    ] as unknown as Domain[];
    const rows = lsRows(list);
    expect(rows[0]).toMatchObject({ id: "d-root", redirect: null, redirects_to: "-" });
    expect(rows[1]).toMatchObject({ id: "d-www", redirects_to: "301 → example.com" });
    expect(rows[1]!["redirect"]).toEqual(list[1]!.redirect);
  });
});

describe("publishDomainDns outcome", () => {
  const plan = {
    credential_label: "cf",
    zone_name: "example.com",
    server_name: "web-1",
    ops: [
      {
        op: "create" as const,
        record_type: "A",
        name: "app.example.com",
        current_content: null,
        current_proxied: null,
        desired_content: "203.0.113.10",
        desired_proxied: true,
        reason: null,
      },
    ],
    plan_hash: "h1",
    blocked_reason: null,
  };

  function client(finalStatus: string, applied: string[]): HttpClient {
    return {
      get: () => Promise.resolve({ dns: { publish: { status: finalStatus, applied, last_error: null } } }),
      post: (path: string) => Promise.resolve(path.includes("/dns/plan/") ? plan : {}),
      patch: () => Promise.resolve({}),
    } as unknown as HttpClient;
  }

  const domain = { id: "d1", dns_publish: { enabled: true, proxied: true } };
  const wait = { proxied: true, attempts: 2, sleepMs: 0, sleep: async () => {} };

  test("a publish that found every record in place reports unchanged, not failed", async () => {
    const out = await publishDomainDns(client("noop", []), "t1", domain, wait);
    expect(out.status).toBe("unchanged");
    expect(out.error).toBeNull();
  });

  test("a publish that wrote records reports published", async () => {
    const out = await publishDomainDns(client("succeeded", ["A app.example.com"]), "t1", domain, wait);
    expect(out.status).toBe("published");
    expect(out.applied).toEqual(["A app.example.com"]);
  });
});

describe("domains add allowlist", () => {
  test("add has the --allow and --cloudflare flags", () => {
    const program = new Command().name("reoclo");
    registerDomains(program);
    const add = program.commands.find((c) => c.name() === "domains")!.commands.find((c) => c.name() === "add")!;
    const longs = add.options.map((o) => o.long);
    expect(longs).toContain("--allow");
    expect(longs).toContain("--cloudflare");
  });

  test("sends ip_allowlist only when a flag is given", async () => {
    const { client } = fakeClient();
    const none = await buildAddBody(client, "T", "a.example.com", { keepPath: true });
    expect(none).toEqual({ fqdn: "a.example.com" });
    const custom = await buildAddBody(client, "T", "a.example.com", { keepPath: true, allow: ["10.0.0.0/8", "1.2.3.4"] });
    expect(custom["ip_allowlist"]).toEqual({ cidrs: ["10.0.0.0/8", "1.2.3.4"], presets: [] });
    const cf = await buildAddBody(client, "T", "a.example.com", { keepPath: true, cloudflare: true });
    expect(cf["ip_allowlist"]).toEqual({ cidrs: [], presets: ["cloudflare"] });
    const both = await buildAddBody(client, "T", "a.example.com", { keepPath: true, allow: ["10.0.0.0/8"], cloudflare: true });
    expect(both["ip_allowlist"]).toEqual({ cidrs: ["10.0.0.0/8"], presets: ["cloudflare"] });
  });
});

describe("domains access", () => {
  const current = { cidrs: ["10.0.0.0/8"], presets: ["cloudflare" as const] };

  test("registered with completion on the domain argument and the flags", () => {
    const program = new Command().name("reoclo");
    registerDomains(program);
    const cmd = program.commands.find((c) => c.name() === "domains")!.commands.find((c) => c.name() === "access")!;
    expect(getCompletionSpec(cmd)!.args).toEqual([{ slot: 0, resource: "domains" }]);
    const longs = cmd.options.map((o) => o.long);
    for (const flag of ["--allow", "--cloudflare", "--no-cloudflare", "--open", "--inherit"]) {
      expect(longs).toContain(flag);
    }
  });

  test("no flags means show, not write", () => {
    expect(accessPatchBody({}, current)).toBeNull();
  });

  test("--open sends empty lists and --inherit sends null", () => {
    expect(accessPatchBody({ open: true }, current)).toEqual({ ip_allowlist: { cidrs: [], presets: [] } });
    expect(accessPatchBody({ inherit: true }, current)).toEqual({ ip_allowlist: null });
  });

  test("--allow alone keeps the existing preset and replaces the ranges", () => {
    expect(accessPatchBody({ allow: ["192.0.2.0/24", "198.51.100.7"] }, current)).toEqual({
      ip_allowlist: { cidrs: ["192.0.2.0/24", "198.51.100.7"], presets: ["cloudflare"] },
    });
  });

  test("--cloudflare and --no-cloudflare alone keep the existing ranges", () => {
    expect(accessPatchBody({ cloudflare: false }, current)).toEqual({
      ip_allowlist: { cidrs: ["10.0.0.0/8"], presets: [] },
    });
    expect(accessPatchBody({ cloudflare: true }, { cidrs: ["10.0.0.0/8"], presets: [] })).toEqual({
      ip_allowlist: { cidrs: ["10.0.0.0/8"], presets: ["cloudflare"] },
    });
  });

  test("a domain that inherits starts from empty", () => {
    expect(accessPatchBody({ cloudflare: true }, null)).toEqual({ ip_allowlist: { cidrs: [], presets: ["cloudflare"] } });
  });

  test("--open and --inherit conflict with each other and with --allow/--cloudflare, exit 2", () => {
    expect(exitCodeOf(() => assertAccessOptions({ open: true, inherit: true }))).toBe(2);
    expect(exitCodeOf(() => accessPatchBody({ open: true, allow: ["10.0.0.0/8"] }, current))).toBe(2);
    expect(exitCodeOf(() => accessPatchBody({ open: true, cloudflare: true }, current))).toBe(2);
    expect(exitCodeOf(() => accessPatchBody({ inherit: true, allow: ["10.0.0.0/8"] }, current))).toBe(2);
    expect(exitCodeOf(() => accessPatchBody({ inherit: true, cloudflare: false }, current))).toBe(2);
  });

  test("removing the last rule exits 2 instead of silently opening access", () => {
    expect(exitCodeOf(() => accessPatchBody({ cloudflare: false }, { cidrs: [], presets: ["cloudflare"] }))).toBe(2);
    expect(exitCodeOf(() => accessPatchBody({ cloudflare: false }, null))).toBe(2);
  });
});

describe("domains ls access column", () => {
  test("lsRows labels inherit, open and summaries and keeps the raw field", () => {
    const list = [
      { id: "1", fqdn: "a.example.com", ip_allowlist: null },
      { id: "2", fqdn: "b.example.com", ip_allowlist: { cidrs: [], presets: [] } },
      { id: "3", fqdn: "c.example.com", ip_allowlist: { cidrs: ["10.0.0.0/8", "1.2.3.4"], presets: ["cloudflare"] } },
      { id: "4", fqdn: "d.example.com" },
    ] as unknown as Domain[];
    const rows = lsRows(list);
    expect(rows.map((r) => r["access"])).toEqual(["inherit", "open", "cloudflare+2", "-"]);
    expect(rows[2]!["ip_allowlist"]).toEqual(list[2]!.ip_allowlist);
  });
});
