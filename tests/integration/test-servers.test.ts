import { afterEach, beforeEach, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { startFakeTestApi, type FakeTestApi, type Routes } from "../helpers/fake-test-api";
import { seedTenantProfile } from "../helpers/seed-profile";

const ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");
const T = "00000000-0000-0000-0000-00000000aaaa";
const POOL = "44444444-4444-4444-4444-444444444444";
const CRED = "66666666-6666-6666-6666-666666666666";
const REPO = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";
const JOB = "33333333-3333-3333-3333-333333333333";

let tmp: string;
let api: FakeTestApi | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reoclo-tests-cmd-"));
});

afterEach(() => api?.stop());

function serve(routes: Routes): FakeTestApi {
  api = startFakeTestApi(routes);
  seedTenantProfile({ configDir: join(tmp, "config"), apiUrl: api.url, token: api.token });
  return api;
}

async function cli(args: string[], cwd: string = tmp): Promise<{ code: number; out: string; err: string }> {
  const r = await $`bun run ${ENTRY} ${args}`
    .cwd(cwd)
    .env({ ...process.env, REOCLO_CONFIG_DIR: join(tmp, "config"), REOCLO_CACHE_DIR: join(tmp, "cache") })
    .nothrow()
    .quiet();
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const pool = { id: POOL, name: "CI", slug: "ci", provider: "hetzner", location: "fsn1", server_type: "cx23", max_machines: 2, live_machines: 0, monthly_budget_cents: 500, budget_currency: "EUR", variables: [{ key: "A", secret: false, value: "1" }, { key: "TOKEN", secret: true, value: null }] };
const repo = { id: REPO, full_name: "acme/web", name: "web", owner_login: "acme", default_branch: "main", status: "active" };
const poolRoutes: Routes = {
  [`GET /tenants/${T}/test-pools`]: { items: [pool], total: 1, skip: 0, limit: 100 },
  [`GET /tenants/${T}/test-pools/${POOL}`]: pool,
  [`GET /tenants/${T}/test-pools/${POOL}/machines`]: { items: [{ id: "m1", state: "ready", server_type: "cx23", location: "fsn1", created_at: "2026-11-12T10:00:00Z", deleted_at: null, error_code: null }], total: 1, skip: 0, limit: 20 },
  [`GET /tenants/${T}/cloud-credentials`]: [{ id: CRED, label: "hetzner-main", provider: "hetzner" }],
  [`GET /tenants/${T}/repositories/`]: { items: [repo] },
};

test("test-pools ls, get and machines read the pool by slug and never show a secret value", async () => {
  serve(poolRoutes);
  expect((await cli(["test-pools", "ls"])).out).toContain("ci");
  const get = await cli(["test-pools", "get", "ci"]);
  expect(get.out).toContain("A=1, TOKEN (secret)");
  expect((await cli(["test-pools", "machines", "ci"])).out).toContain("ready");
});

test("test-pools create sends the resolved credential, cents budget and variables", async () => {
  const fake = serve({ ...poolRoutes, [`POST /tenants/${T}/test-pools`]: (req) => ({ ...pool, ...(req.body as object), variables: [] }) });
  const r = await cli(["test-pools", "create", "--name", "CI", "--credential", "hetzner-main", "--location", "fsn1", "--server-type", "cx23", "--fallback-type", "cpx22", "--max-machines", "3", "--budget", "5", "--var", "A=1", "--secret", "TOKEN=s3cret"]);
  expect(r.code).toBe(0);
  expect(r.out + r.err).not.toContain("s3cret");
  expect(fake.calls("POST", `/tenants/${T}/test-pools`)[0]?.body).toEqual({
    name: "CI",
    location: "fsn1",
    server_type: "cx23",
    fallback_server_types: ["cpx22"],
    max_machines: 3,
    monthly_budget_cents: 500,
    provider: "hetzner",
    cloud_credential_id: CRED,
    variables: [{ key: "A", value: "1", secret: false }, { key: "TOKEN", value: "s3cret", secret: true }],
  });
});

test("test-pools edit patches only what changed and unsets by key", async () => {
  const fake = serve({ ...poolRoutes, [`PATCH /tenants/${T}/test-pools/${POOL}`]: pool });
  const r = await cli(["test-pools", "edit", "ci", "--max-machines", "4", "--secret", "TOKEN=next", "--unset-var", "OLD"]);
  expect(r.code).toBe(0);
  expect(fake.calls("PATCH", `/tenants/${T}/test-pools/${POOL}`)[0]?.body).toEqual({
    max_machines: 4,
    variables: { TOKEN: { value: "next", secret: true }, OLD: null },
  });
});

test("test-pools rm asks first and only deletes with --yes", async () => {
  const fake = serve({ ...poolRoutes, [`DELETE /tenants/${T}/test-pools/${POOL}`]: null });
  const refused = await cli(["test-pools", "rm", "ci"]);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("--yes");
  expect(fake.calls("DELETE", `/tenants/${T}/test-pools/${POOL}`)).toHaveLength(0);
  expect((await cli(["test-pools", "rm", "ci", "--yes"])).code).toBe(0);
  expect(fake.calls("DELETE", `/tenants/${T}/test-pools/${POOL}`)).toHaveLength(1);
});

const overview = { tests_enabled: false, definitions: [{ name: "unit", path: "ci/reoclo/tests/unit.yml", sha: "abcdef1234", validation_error: null, spec: { pool: "ci", on: { manual: true, push: { branches: ["main"] } }, jobs: { a: {} } } }] };
const repoRoutes: Routes = {
  ...poolRoutes,
  [`GET /tenants/${T}/repositories/${REPO}/tests`]: overview,
  [`POST /tenants/${T}/repositories/${REPO}/tests/refresh`]: overview,
  [`PATCH /tenants/${T}/repositories/${REPO}/test-settings`]: (req) => ({ ...overview, tests_enabled: (req.body as { enabled: boolean }).enabled }),
};

test("tests ls lists the files and points at enable while tests are off; --refresh re-reads the branch", async () => {
  const fake = serve(repoRoutes);
  const r = await cli(["tests", "ls", "--repo", "acme/web", "--refresh"]);
  expect(r.out).toContain("manual, push main");
  expect(r.err).toContain("reoclo tests enable --repo acme/web");
  expect(fake.calls("POST", `/tenants/${T}/repositories/${REPO}/tests/refresh`)).toHaveLength(1);
});

test("tests enable shows the trust warning and needs --yes; disable asks nothing", async () => {
  const fake = serve(repoRoutes);
  const path = `/tenants/${T}/repositories/${REPO}/test-settings`;
  const refused = await cli(["tests", "enable", "--repo", "acme/web"]);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("Anyone who can push to acme/web");
  expect(fake.calls("PATCH", path)).toHaveLength(0);
  expect((await cli(["tests", "enable", "--repo", "acme/web", "--yes"])).code).toBe(0);
  expect((await cli(["tests", "disable", "--repo", "acme/web"])).code).toBe(0);
  expect(fake.calls("PATCH", path).map((r) => r.body)).toEqual([{ enabled: true }, { enabled: false }]);
});

const runRow = (state: string) => ({ id: RUN, number: 5, repository_id: REPO, test_name: "unit", commit_sha: "abcdef1234", ref: "main", trigger: "manual", state, error: null, created_at: "2026-11-12T10:00:00Z", started_at: "2026-11-12T10:00:01Z", finished_at: state === "running" ? null : "2026-11-12T10:00:30Z" });
const jobRow = (state: string, exit: number | null) => ({ id: JOB, run_id: RUN, key: "build", needs: [], image: "alpine", state, wait_reason: null, exit_code: exit, error: null, step_results: [{ index: 0, name: "Say hi", state: state === "running" ? "running" : state === "passed" ? "passed" : "failed", exit_code: exit }], started_at: "2026-11-12T10:00:01Z", finished_at: null });
const logs = { items: [{ step: 0, seq: 0, ts: "t", stream: "stdout", text: "hello from the job" }], next_after_seq: 0 };

function runRoutes(snapshots: Array<[string, string, number | null]>): Routes {
  let polled = 0;
  return {
    ...repoRoutes,
    [`POST /tenants/${T}/repositories/${REPO}/tests/unit/runs`]: runRow("queued"),
    [`GET /tenants/${T}/test-runs/${RUN}`]: () => {
      const [run, job, exit] = snapshots[Math.min(polled++, snapshots.length - 1)] ?? ["errored", "errored", null];
      return { ...runRow(run), jobs: [jobRow(job, exit)] };
    },
    [`GET /tenants/${T}/test-runs/${RUN}/jobs/${JOB}/logs`]: (req) => (req.query.get("after_seq") === "-1" ? logs : { items: [], next_after_seq: 0 }),
    [`POST /tenants/${T}/test-runs/${RUN}/cancel`]: runRow("cancelling"),
    [`POST /tenants/${T}/test-runs/${RUN}/rerun`]: runRow("queued"),
    [`GET /tenants/${T}/test-runs`]: (req) => ({ items: req.query.get("cursor") === "6" || !req.query.has("cursor") ? [runRow("passed")] : [], next_cursor: null }),
  };
}

for (const [state, job, exit, code] of [["failed", "failed", 1, 1], ["errored", "errored", null, 2], ["cancelled", "cancelled", null, 2]] as const) {
  test(`tests run --wait exits ${code} when the run ${state}`, async () => {
    serve(runRoutes([[state, job, exit]]));
    const r = await cli(["tests", "run", "unit", "--repo", "acme/web", "--wait"]);
    expect(r.code).toBe(code);
    expect(r.out).toContain("hello from the job");
    expect(r.out).toContain(`run #5 ${state}`);
  });
}

test("tests run --wait follows the run to the end and exits 0 when it passes", async () => {
  const fake = serve(runRoutes([["running", "running", null], ["passed", "passed", 0]]));
  const r = await cli(["tests", "run", "unit", "--repo", "acme/web", "--ref", "release", "--sha", "ABCDEF1", "--wait"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("job build: running");
  expect(r.out).toContain("step 1 Say hi: passed");
  expect(r.out).toContain("run #5 passed in 29s");
  expect(fake.calls("POST", `/tenants/${T}/repositories/${REPO}/tests/unit/runs`)[0]?.body).toEqual({ ref: "release", sha: "abcdef1" });
});

test("tests run without --wait starts the run and exits 0 at once", async () => {
  serve(runRoutes([["queued", "pending", null]]));
  const r = await cli(["tests", "run", "unit", "--repo", "acme/web"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("run #5 started");
});

test("tests run --input sends the inputs by name, keeps a value that contains '=' and sends no key when none are given", async () => {
  const fake = serve(runRoutes([["queued", "pending", null]]));
  const path = `/tenants/${T}/repositories/${REPO}/tests/unit/runs`;
  const given = await cli(["tests", "run", "unit", "--repo", "acme/web", "--input", "room_link=https://rooms.example/r?id=4821", "--input", "note="]);
  expect(given.code).toBe(0);
  expect(fake.calls("POST", path)[0]?.body).toEqual({ inputs: { room_link: "https://rooms.example/r?id=4821", note: "" } });
  expect((await cli(["tests", "run", "unit", "--repo", "acme/web"])).code).toBe(0);
  expect(fake.calls("POST", path)[1]?.body).toEqual({});
});

test("tests run shows the API's message naming the inputs it refused and exits 1", async () => {
  serve({
    ...runRoutes([["queued", "pending", null]]),
    [`POST /tenants/${T}/repositories/${REPO}/tests/unit/runs`]: () => Response.json({ detail: "Unknown inputs: 'nope'. Missing required inputs: 'room_link'" }, { status: 422 }),
  });
  const r = await cli(["tests", "run", "unit", "--repo", "acme/web", "--input", "nope=1"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("Unknown inputs: 'nope'. Missing required inputs: 'room_link'");
});

test("runs, show, logs, cancel and rerun take a run number", async () => {
  const fake = serve(runRoutes([["passed", "passed", 0]]));
  expect((await cli(["tests", "runs", "--repo", "acme/web", "--state", "passed"])).out).toContain("unit");
  expect(fake.calls("GET", `/tenants/${T}/test-runs`)[0]?.query.get("state")).toBe("passed");
  expect((await cli(["tests", "show", "5"])).out).toContain("build");
  expect((await cli(["tests", "logs", "5", "--job", "build"])).out).toContain("hello from the job");
  expect((await cli(["tests", "cancel", "5"])).out).toContain("cancel requested: run #5");
  expect((await cli(["tests", "rerun", "#5"])).out).toContain("run #5 started");
  expect((await cli(["tests", "show", "9"])).code).toBe(5);
});

test("tests init writes a starter that the spec accepts, and refuses to overwrite without --force", async () => {
  const r = await cli(["tests", "init", "smoke", "--pool", "ci"]);
  expect(r.code).toBe(0);
  const file = join(tmp, "ci", "reoclo", "tests", "smoke.yml");
  const spec = load(readFileSync(file, "utf8")) as { version: number; pool: string; on: { manual: boolean; push: { branches: string[] } }; jobs: { test: { image: string; steps: Array<{ run: string }> } } };
  expect(spec.version).toBe(1);
  expect(spec.pool).toBe("ci");
  expect(spec.on.manual).toBe(true);
  expect(spec.on.push.branches).toHaveLength(1);
  expect(spec.jobs.test.steps).toHaveLength(2);
  expect(spec.jobs.test.steps[0]?.run).toBe("ls -la");

  writeFileSync(file, "changed");
  const again = await cli(["tests", "init", "smoke", "--pool", "ci"]);
  expect(again.code).toBe(1);
  expect(again.err).toContain("--force");
  expect(readFileSync(file, "utf8")).toBe("changed");
  expect((await cli(["tests", "init", "smoke", "--pool", "ci", "--force"])).code).toBe(0);
  expect(readFileSync(file, "utf8")).not.toBe("changed");
  expect(existsSync(join(tmp, "ci", "reoclo", "tests"))).toBe(true);
});

const verdicts: Routes = {
  [`POST /tenants/${T}/tests/validate`]: (req) => {
    const { name } = req.body as { name: string };
    if (name === "big") return Response.json({ detail: "content too large" }, { status: 422 });
    return name === "bad"
      ? { valid: false, error: "jobs.test.steps: Field required", test: null }
      : { valid: true, error: null, test: { name, pool: "ci", on: { manual: true, push: { branches: ["main"] } }, jobs: [{ key: "test", image: "alpine", needs: [], steps: 2 }], order: ["test"] } };
  },
};

function writeTest(name: string): void {
  const dir = join(tmp, "ci", "reoclo", "tests");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yml`), `version: 1\npool: ci\n# ${name}\n`);
}

test("tests validate prints each verdict and exits 1 when any file is invalid", async () => {
  const fake = serve(verdicts);
  writeTest("ok");
  writeTest("bad");
  const r = await cli(["tests", "validate"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("ok.yml: valid (pool ci, 1 job, 2 steps, on manual and push main)");
  expect(r.out).toContain("bad.yml: invalid: jobs.test.steps: Field required");
  expect(fake.calls("POST", `/tenants/${T}/tests/validate`).map((c) => (c.body as { name: string }).name)).toEqual(["bad", "ok"]);
});

test("tests validate exits 0 when every file is valid and treats a 422 as invalid", async () => {
  serve(verdicts);
  writeTest("ok");
  expect((await cli(["tests", "validate"])).code).toBe(0);
  writeTest("big");
  const r = await cli(["tests", "validate", "ci/reoclo/tests/big.yml"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("invalid: content too large");
});

test("tests validate with no test files exits 1 and points at init", async () => {
  serve(verdicts);
  const r = await cli(["tests", "validate"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("reoclo tests init");
});
