import { describe, expect, test } from "bun:test";
import { FakeApi, repo, TID } from "../../helpers/fake-api";
import {
  drainJobLogs,
  elapsed,
  resolveTestPool,
  resolveTestRepository,
  resolveTestRun,
  runExitCode,
  type TestLogLine,
} from "../../../src/client/testing";

const RUN_ID = "22222222-2222-2222-2222-222222222222";
const exitCodeOf = async (promise: Promise<unknown>): Promise<number | undefined> =>
  ((await promise.catch((e: unknown) => e)) as { exitCode?: number }).exitCode;

describe("runExitCode", () => {
  test("a pipeline sees 0 passed, 1 failed, 2 errored or cancelled, and nothing while the run is live", () => {
    expect(runExitCode("passed")).toBe(0);
    expect(runExitCode("failed")).toBe(1);
    expect(runExitCode("errored")).toBe(2);
    expect(runExitCode("cancelled")).toBe(2);
    for (const live of ["queued", "running", "cancelling"]) expect(runExitCode(live)).toBeNull();
  });
});

describe("resolveTestRun", () => {
  test("an id is used as given and a number is looked up through the run list cursor", async () => {
    const api = new FakeApi().on("GET", `/tenants/${TID}/test-runs`, () => ({ items: [{ id: RUN_ID, number: 12 }], next_cursor: null }));
    expect(await resolveTestRun(api, TID, RUN_ID)).toBe(RUN_ID);
    expect(api.requests).toHaveLength(0);
    expect(await resolveTestRun(api, TID, "12")).toBe(RUN_ID);
    expect(await resolveTestRun(api, TID, "#12")).toBe(RUN_ID);
    expect(api.requests.map((r) => r.query.get("cursor"))).toEqual(["13", "13"]);
  });

  test("a number with no run exits 5 and text that is not a run exits 2", async () => {
    const api = new FakeApi().on("GET", `/tenants/${TID}/test-runs`, () => ({ items: [{ id: RUN_ID, number: 11 }], next_cursor: null }));
    expect(await exitCodeOf(resolveTestRun(api, TID, "12"))).toBe(5);
    expect(await exitCodeOf(resolveTestRun(api, TID, "latest"))).toBe(2);
  });
});

describe("resolveTestRepository", () => {
  const listing = (api: FakeApi, items: unknown[]): FakeApi => api.on("GET", `/tenants/${TID}/repositories/`, () => ({ items }));

  test("owner/name searches by name and picks the exact full name", async () => {
    const api = listing(new FakeApi(), [repo({ id: "A", full_name: "other/web", owner_login: "other" }), repo({ id: "B" })]);
    expect(await resolveTestRepository(api, TID, "acme/web", () => null)).toEqual({ id: "B", label: "acme/web" });
    expect(api.requests[0]?.query.get("q")).toBe("web");
  });

  test("an id needs no lookup and an omitted --repo reads the origin remote", async () => {
    const api = listing(new FakeApi(), [repo()]);
    const id = "11111111-1111-1111-1111-111111111111";
    expect(await resolveTestRepository(api, TID, id, () => null)).toEqual({ id, label: id });
    expect(api.requests).toHaveLength(0);
    expect((await resolveTestRepository(api, TID, undefined, () => "git@github.com:acme/web.git")).label).toBe("acme/web");
  });

  test("no origin remote exits 2 and an unlinked repository exits 5 with the link command", async () => {
    const api = listing(new FakeApi(), []);
    expect(await exitCodeOf(resolveTestRepository(api, TID, undefined, () => null))).toBe(2);
    const error = (await resolveTestRepository(api, TID, "acme/web", () => null).catch((e: unknown) => e)) as Error & { exitCode: number };
    expect(error.exitCode).toBe(5);
    expect(error.message).toContain("reoclo repos link acme/web");
  });
});

describe("resolveTestPool", () => {
  test("a slug resolves to its id and an unknown slug exits 5 listing the known ones", async () => {
    const api = new FakeApi().on("GET", `/tenants/${TID}/test-pools`, () => ({ items: [{ id: "P1", slug: "ci", name: "CI" }], total: 1, skip: 0, limit: 100 }));
    expect(await resolveTestPool(api, TID, "ci")).toBe("P1");
    const error = (await resolveTestPool(api, TID, "nope").catch((e: unknown) => e)) as Error & { exitCode: number };
    expect(error.exitCode).toBe(5);
    expect(error.message).toContain("available: ci");
  });
});

describe("drainJobLogs", () => {
  const line = (seq: number): TestLogLine => ({ step: 0, seq, ts: "t", stream: "stdout", text: `l${seq}` });

  test("reads page after page from the returned cursor", async () => {
    const full = Array.from({ length: 5000 }, (_, i) => line(i));
    const api = new FakeApi().on("GET", `/tenants/${TID}/test-runs/R/jobs/J/logs`, (req) =>
      req.query.get("after_seq") === "-1" ? { items: full, next_after_seq: 4999 } : { items: [line(5000), line(5001)], next_after_seq: 5001 },
    );
    const seen: string[] = [];
    const cursor = await drainJobLogs(api, TID, { id: "J", run_id: "R" }, -1, (l) => void seen.push(l.text));
    expect(seen).toHaveLength(5002);
    expect(cursor).toBe(5001);
    expect(api.requests.map((r) => r.query.get("after_seq"))).toEqual(["-1", "4999"]);
  });
});

test("elapsed renders seconds and minutes", () => {
  expect(elapsed("2026-11-12T10:00:00Z", "2026-11-12T10:00:42Z")).toBe("42s");
  expect(elapsed("2026-11-12T10:00:00Z", "2026-11-12T10:01:05Z")).toBe("1m05s");
  expect(elapsed(null, null)).toBe("");
});
