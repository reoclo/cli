import { describe, expect, test } from "bun:test";
import { FakeApi, TID } from "../../helpers/fake-api";
import { followRun, streamLogs, type FollowDeps } from "../../../src/commands/tests-follow";
import type { TestJob, TestRunDetail } from "../../../src/client/testing";

const RUN = `/tenants/${TID}/test-runs/R1`;

const job = (over: Partial<TestJob> = {}): TestJob => ({
  id: "J1",
  run_id: "R1",
  key: "build",
  needs: [],
  image: "alpine",
  state: "pending",
  wait_reason: null,
  exit_code: null,
  error: null,
  step_results: [{ index: 0, name: "Install", state: "pending", exit_code: null }],
  started_at: null,
  finished_at: null,
  ...over,
});

const detail = (state: TestRunDetail["state"], jobs: TestJob[], over: Partial<TestRunDetail> = {}): TestRunDetail => ({
  id: "R1",
  number: 7,
  repository_id: "repo",
  test_name: "unit",
  commit_sha: "abcdef1234",
  ref: "main",
  trigger: "manual",
  state,
  error: null,
  created_at: "2026-11-12T10:00:00Z",
  started_at: null,
  finished_at: null,
  jobs,
  ...over,
});

interface Harness { api: FakeApi; deps: FollowDeps; written: string[]; sleeps: number[]; interruptOnSleep: (n: number) => void }

function harness(
  snapshots: TestRunDetail[],
  lines: Record<string, string[]> = { J1: ["a", "b"] },
  answer = false,
  logsFromPoll = 1,
): Harness {
  let polled = 0;
  const api = new FakeApi().on("GET", RUN, () => snapshots[Math.min(polled++, snapshots.length - 1)]);
  for (const jobId of ["J1", "J2"]) {
    const texts = lines[jobId] ?? [];
    api.on("GET", `${RUN}/jobs/${jobId}/logs`, (req) => {
      const after = Number(req.query.get("after_seq"));
      const items = (polled >= logsFromPoll ? texts : []).map((text, seq) => ({ step: 0, seq, ts: "t", stream: "stdout", text })).filter((l) => l.seq > after);
      return { items, next_after_seq: items.length > 0 ? (items.at(-1)?.seq ?? after) : after };
    });
  }
  api.on("POST", `${RUN}/cancel`, {});
  const written: string[] = [];
  const sleeps: number[] = [];
  let pending = false;
  let interruptAt = -1;
  const deps: FollowDeps = {
    client: api,
    tid: TID,
    write: (line) => void written.push(line),
    sleep: (ms) => {
      sleeps.push(ms);
      if (sleeps.length === interruptAt) pending = true;
      return Promise.resolve();
    },
    interrupted: () => {
      const was = pending;
      pending = false;
      return was;
    },
    askCancel: () => Promise.resolve(answer),
  };
  return { api, deps, written, sleeps, interruptOnSleep: (n) => void (interruptAt = n) };
}

describe("followRun", () => {
  test("prints each state change once, the step headings, the logs and the step results in order", async () => {
    const running = job({ state: "running", step_results: [{ index: 0, name: "Install", state: "running", exit_code: null }] });
    const passed = job({ state: "passed", exit_code: 0, step_results: [{ index: 0, name: "Install", state: "passed", exit_code: 0 }] });
    const h = harness([detail("queued", [job()]), detail("running", [running]), detail("running", [running]), detail("passed", [passed])], undefined, false, 2);
    const { run, detached } = await followRun(h.deps, "R1");
    expect(detached).toBe(false);
    expect(run.state).toBe("passed");
    expect(h.written).toEqual([
      "run #7 queued",
      "job build: pending",
      "run #7 running",
      "job build: running",
      "step 1 Install",
      "a",
      "b",
      "step 1 Install: passed",
      "job build: passed (exit 0)",
      "run #7 passed",
    ]);
    expect(h.sleeps).toEqual([2000, 2000, 2000]);
  });

  test("a failed step shows its exit code and a run error is printed", async () => {
    const failed = job({ state: "failed", exit_code: 1, step_results: [{ index: 0, name: "Install", state: "failed", exit_code: 1 }] });
    const h = harness([detail("failed", [failed], { error: "boom" })]);
    const { run } = await followRun(h.deps, "R1");
    expect(run.state).toBe("failed");
    expect(h.written).toContain("step 1 Install: failed (exit 1)");
    expect(h.written.at(-1)).toBe("run error: boom");
  });

  test("a run with several jobs prefixes every line with its job key", async () => {
    const jobs = [job({ id: "J1", key: "unit", state: "passed", exit_code: 0 }), job({ id: "J2", key: "lint", state: "passed", exit_code: 0 })];
    const h = harness([detail("passed", jobs)], { J1: ["u1"], J2: ["l1"] });
    await followRun(h.deps, "R1");
    expect(h.written).toContain("[unit] u1");
    expect(h.written).toContain("[lint] l1");
  });

  test("Ctrl+C answered no stops waiting and leaves the run going", async () => {
    const h = harness([detail("running", [job({ state: "running" })])], {}, false);
    h.interruptOnSleep(1);
    const { detached, run } = await followRun(h.deps, "R1");
    expect(detached).toBe(true);
    expect(run.state).toBe("running");
    expect(h.api.calls("POST", `${RUN}/cancel`)).toHaveLength(0);
  });

  test("Ctrl+C answered yes cancels the run and waits until it is cancelled", async () => {
    const h = harness([detail("running", [job({ state: "running" })]), detail("cancelling", [job({ state: "running" })]), detail("cancelled", [job({ state: "cancelled" })])], {}, true);
    h.interruptOnSleep(1);
    const { detached, run } = await followRun(h.deps, "R1");
    expect(detached).toBe(false);
    expect(run.state).toBe("cancelled");
    expect(h.api.calls("POST", `${RUN}/cancel`)).toHaveLength(1);
    expect(h.written).toContain("cancel requested for run #7");
  });
});

describe("streamLogs", () => {
  test("prints the logs of the chosen job once without --follow", async () => {
    const jobs = [job({ id: "J1", key: "unit" }), job({ id: "J2", key: "lint" })];
    const h = harness([detail("running", jobs)], { J1: ["u1"], J2: ["l1"] });
    await streamLogs(h.deps, "R1", "lint", false);
    expect(h.written).toEqual(["step 1 Install", "l1"]);
    expect(h.sleeps).toEqual([]);
  });

  test("--follow keeps reading new lines until the run is terminal", async () => {
    const h = harness([detail("running", [job({ state: "running" })]), detail("passed", [job({ state: "passed" })])]);
    await streamLogs(h.deps, "R1", undefined, true);
    expect(h.sleeps).toEqual([2000]);
    expect(h.written.filter((l) => l === "a")).toHaveLength(1);
  });

  test("an unknown job exits 5 and names the run's jobs", async () => {
    const h = harness([detail("running", [job({ key: "unit" })])]);
    const error = (await streamLogs(h.deps, "R1", "nope", false).catch((e: unknown) => e)) as Error & { exitCode: number };
    expect(error.exitCode).toBe(5);
    expect(error.message).toContain("jobs: unit");
  });
});
