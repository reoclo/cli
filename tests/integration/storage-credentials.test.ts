import { afterEach, beforeEach, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeTestApi, type FakeTestApi, type Routes } from "../helpers/fake-test-api";
import { seedTenantProfile } from "../helpers/seed-profile";

const ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");
const T = "00000000-0000-0000-0000-00000000aaaa";
const R2 = "55555555-5555-5555-5555-555555555555";
const BASE = `/tenants/${T}/storage-credentials`;

let tmp: string;
let api: FakeTestApi | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reoclo-storage-cmd-"));
});

afterEach(() => api?.stop());

function serve(routes: Routes): FakeTestApi {
  api = startFakeTestApi(routes);
  seedTenantProfile({ configDir: join(tmp, "config"), apiUrl: api.url, token: api.token });
  return api;
}

async function cli(args: string[], stdin = ""): Promise<{ code: number; out: string; err: string }> {
  const r = await $`bun run ${ENTRY} ${args} < ${new Response(stdin)}`
    .cwd(tmp)
    .env({ ...process.env, REOCLO_CONFIG_DIR: join(tmp, "config"), REOCLO_CACHE_DIR: join(tmp, "cache") })
    .nothrow()
    .quiet();
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const r2 = {
  id: R2,
  name: "r2-main",
  endpoint: "https://acct.r2.cloudflarestorage.com",
  access_key_id: "AKIA1",
  description: null,
  pools: [{ id: "p1", name: "ci", bucket: "ci-cache" }],
};
const routes: Routes = {
  [`GET ${BASE}`]: { items: [r2], total: 1, skip: 0, limit: 100 },
  [`GET ${BASE}/${R2}`]: r2,
};

test("ls shows name, endpoint, access key id, pools and id, and pages with --skip and --limit", async () => {
  const fake = serve(routes);
  const out = (await cli(["-o", "text", "storage-credentials", "ls", "--skip", "5", "--limit", "10"])).out;
  expect(out).toMatch(/NAME\s+ENDPOINT\s+ACCESS KEY ID\s+POOLS\s+ID/);
  expect(out).toContain("r2-main");
  expect(out).toContain("AKIA1");
  expect(out).toContain("ci");
  const page = fake.calls("GET", BASE).find((c) => c.query.get("skip") === "5");
  expect(page?.query.get("limit")).toBe("10");
});

test("get resolves a name and shows the pools using the credential, never a secret", async () => {
  serve(routes);
  const out = (await cli(["-o", "text", "storage-credentials", "get", "r2-main"])).out;
  expect(out).toMatch(/access_key_id\s+AKIA1/);
  expect(out).toMatch(/pools\s+ci/);
  expect(out).not.toContain("secret");
});

test("create reads the secret key from stdin, posts it and never prints it", async () => {
  const fake = serve({ ...routes, [`POST ${BASE}`]: (req) => ({ ...r2, ...(req.body as object), secret_key: undefined }) });
  const run = await cli(
    ["storage-credentials", "create", "--name", "r2-main", "--access-key-id", "AKIA1", "--endpoint", "https://acct.r2.cloudflarestorage.com", "--description", "CI cache", "--secret-key-stdin"],
    "s3cret-value\n",
  );
  expect(run.code).toBe(0);
  expect(run.out + run.err).not.toContain("s3cret-value");
  expect(fake.calls("POST", BASE)[0]?.body).toEqual({
    name: "r2-main",
    access_key_id: "AKIA1",
    secret_key: "s3cret-value",
    endpoint: "https://acct.r2.cloudflarestorage.com",
    description: "CI cache",
  });
});

test("create without a secret on stdin and no terminal exits 5 and sends nothing", async () => {
  const fake = serve(routes);
  const run = await cli(["storage-credentials", "create", "--name", "r2-main", "--access-key-id", "AKIA1"]);
  expect(run.code).toBe(5);
  expect(run.err).toContain("--secret-key-stdin");
  expect(fake.requests).toHaveLength(0);
});

test("edit by name patches only what changed; a new endpoint needs the new secret", async () => {
  const fake = serve({ ...routes, [`PATCH ${BASE}/${R2}`]: r2 });
  expect((await cli(["storage-credentials", "edit", "r2-main", "--description", "main cache"])).code).toBe(0);
  const refused = await cli(["storage-credentials", "edit", "r2-main", "--endpoint", "https://other.example"]);
  expect(refused.code).toBe(2);
  expect((await cli(["storage-credentials", "edit", "r2-main", "--endpoint", "https://other.example", "--secret-key-stdin"], "next-secret\n")).code).toBe(0);
  expect(fake.calls("PATCH", `${BASE}/${R2}`).map((c) => c.body)).toEqual([
    { description: "main cache" },
    { endpoint: "https://other.example", secret_key: "next-secret" },
  ]);
});

test("rm asks first and only deletes with --yes", async () => {
  const fake = serve({ ...routes, [`DELETE ${BASE}/${R2}`]: null });
  const refused = await cli(["storage-credentials", "rm", "r2-main"]);
  expect(refused.code).toBe(1);
  expect(fake.calls("DELETE", `${BASE}/${R2}`)).toHaveLength(0);
  expect((await cli(["storage-credentials", "delete", "r2-main", "--yes"])).code).toBe(0);
  expect(fake.calls("DELETE", `${BASE}/${R2}`)).toHaveLength(1);
});
