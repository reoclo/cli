import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { seedTenantProfile } from "../helpers/seed-profile";

const T = "00000000-0000-0000-0000-00000000aaaa";
const SERVER = "11111111-1111-4111-8111-111111111111";
const REPO = "22222222-2222-4222-8222-222222222222";
const APP = "33333333-3333-4333-8333-333333333333";
const DOMAIN = "44444444-4444-4444-8444-444444444444";
const PROJECT = "55555555-5555-4555-8555-555555555555";

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

let tmp: string;
let server: ReturnType<typeof Bun.serve>;
let seen: Seen[];
let planBlockedReason: string | null;
let publishStatus: string;

beforeEach(() => {
  seen = [];
  planBlockedReason = null;
  publishStatus = "idle";
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname.replace(/^\/mcp/, "");
      const text = await req.text();
      const body: unknown = text === "" ? undefined : JSON.parse(text);
      seen.push({ method: req.method, path, body });
      const route = `${req.method} ${path}`;
      const base = `/tenants/${T}`;
      switch (route) {
        case `GET ${base}/secret-projects`:
          return Response.json([{ id: PROJECT, name: "staging-secrets" }]);
        case `POST ${base}/applications/`:
          return Response.json({ id: APP, slug: "stack", name: "stack" });
        case `POST ${base}/secret-projects`:
          return Response.json({ id: PROJECT, name: "new-project" });
        case `POST ${base}/applications/${APP}/deploy`:
          return Response.json({ id: "dep-1", status: "pending" });
        case `POST ${base}/servers/${SERVER}/proxy/reconcile-now`:
          return Response.json({ triggered: true });
        case `POST ${base}/servers/${SERVER}/exec`:
          return Response.json({ exit_code: 0, stdout: "ok", stderr: "", truncated: false });
        case `GET ${base}/domains/`:
          return Response.json([{ id: DOMAIN, fqdn: "app.example.com", status: "verified" }]);
        case `PATCH ${base}/domains/${DOMAIN}`:
          return Response.json({ id: DOMAIN });
        case `GET ${base}/domains/${DOMAIN}`:
          return Response.json({
            id: DOMAIN,
            dns: { publish: { status: publishStatus, applied: ["A app.example.com"], last_error: null } },
          });
        case `POST ${base}/dns/plan/${DOMAIN}`:
          return Response.json({
            credential_label: "cf",
            zone_name: "example.com",
            server_name: "web1",
            ops: [
              {
                op: "create",
                record_type: "A",
                name: "app.example.com",
                current_content: null,
                current_proxied: null,
                desired_content: "203.0.113.7",
                desired_proxied: false,
                reason: null,
              },
            ],
            plan_hash: "hash-1234",
            blocked_reason: planBlockedReason,
          });
        case `POST ${base}/dns/publish/${DOMAIN}`:
          publishStatus = "succeeded";
          return Response.json({ status: "scheduled" }, { status: 202 });
        default:
          return new Response(`unexpected ${route}`, { status: 404 });
      }
    },
  });
  tmp = mkdtempSync(join(tmpdir(), "reoclo-reo-"));
  seedTenantProfile({ configDir: tmp, apiUrl: `http://localhost:${server.port}`, token: "rk_t_test" });
});

afterEach(() => {
  void server.stop(true);
});

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function bodyOf(method: string, path: string): unknown {
  return seen.find((s) => s.method === method && s.path === path)?.body;
}

test("apps create sends an ApplicationCreate body to the slash-terminated route", async () => {
  const r = await run([
    "apps", "create",
    "--name", "stack",
    "--server", SERVER,
    "--repo", REPO,
    "--compose-file", "deploy/compose.staging.yml",
    "--compose-service", "web",
    "--deploy-branch", "staging",
    "--require-ci",
    "--bind", "staging-secrets",
  ]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("created application stack");
  expect(bodyOf("POST", `/tenants/${T}/applications/`)).toEqual({
    name: "stack",
    server_id: SERVER,
    repository_id: REPO,
    build: {
      build_pack: "docker_compose",
      compose_file_path: "deploy/compose.staging.yml",
      compose_service: "web",
    },
    deploy: { deploy_branch: "staging" },
    require_ci: true,
    secret_project_bindings: [{ project_id: PROJECT }],
  });
});

test("apps create -o json prints the created application", async () => {
  const r = await run(["-o", "json", "apps", "create", "--name", "stack", "--server", SERVER]);
  expect(r.exitCode).toBe(0);
  expect((JSON.parse(r.stdout) as { id: string }).id).toBe(APP);
});

test("apps create rejects compose flags that contradict --build-pack", async () => {
  const r = await run([
    "apps", "create", "--name", "x", "--server", SERVER,
    "--build-pack", "dockerfile", "--compose-service", "web",
  ]);
  expect(r.exitCode).toBe(2);
  expect(seen.some((s) => s.method === "POST")).toBe(false);
});

test("secrets projects create posts to the route without a trailing slash", async () => {
  const r = await run(["secrets", "projects", "create", "new-project", "--description", "for staging"]);
  expect(r.exitCode).toBe(0);
  expect(bodyOf("POST", `/tenants/${T}/secret-projects`)).toEqual({
    name: "new-project",
    description: "for staging",
  });
});

test("apps deploy --ref sends the ref body field", async () => {
  const r = await run(["apps", "deploy", APP, "--ref", "feat/x"]);
  expect(r.exitCode).toBe(0);
  expect(bodyOf("POST", `/tenants/${T}/applications/${APP}/deploy`)).toEqual({ ref: "feat/x" });
});

test("proxy reconcile calls the reconcile-now endpoint", async () => {
  const r = await run(["proxy", "reconcile", SERVER]);
  expect(r.exitCode).toBe(0);
  expect(seen.some((s) => s.method === "POST" && s.path === `/tenants/${T}/servers/${SERVER}/proxy/reconcile-now`)).toBe(true);
});

test("exec sends the documented 600 s timeout when --timeout is absent", async () => {
  const r = await run(["exec", SERVER, "--", "echo", "ok"]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe("ok");
  expect(bodyOf("POST", `/tenants/${T}/servers/${SERVER}/exec`)).toMatchObject({ timeout: 600 });
});

test("domains publish enables publishing, plans, then publishes", async () => {
  const r = await run(["domains", "publish", "app.example.com", "--proxied"]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("203.0.113.7");
  expect(r.stdout).toContain("published: A app.example.com");
  const steps = seen.filter((s) => s.method !== "GET").map((s) => `${s.method} ${s.path.replace(`/tenants/${T}`, "")}`);
  expect(steps).toEqual([`PATCH /domains/${DOMAIN}`, `POST /dns/plan/${DOMAIN}`, `POST /dns/publish/${DOMAIN}`]);
  expect(bodyOf("PATCH", `/tenants/${T}/domains/${DOMAIN}`)).toEqual({
    dns_publish: { enabled: true, proxied: true },
  });
  expect(bodyOf("POST", `/tenants/${T}/dns/plan/${DOMAIN}`)).toEqual({ proxied: true });
  expect(bodyOf("POST", `/tenants/${T}/dns/publish/${DOMAIN}`)).toEqual({
    plan_hash: "hash-1234",
    proxied: true,
  });
});

test("domains publish exits non-zero and does not publish when the plan is blocked", async () => {
  planBlockedReason = "no Cloudflare token covers example.com";
  const r = await run(["domains", "publish", "app.example.com"]);
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain("no Cloudflare token covers example.com");
  expect(seen.some((s) => s.path === `/tenants/${T}/dns/publish/${DOMAIN}`)).toBe(false);
});
