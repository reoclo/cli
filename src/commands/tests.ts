// src/commands/tests.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import type { HttpClient } from "../client/http";
import {
  elapsed,
  resolveTestRepository,
  resolveTestRun,
  RUN_STATES,
  runExitCode,
  shortSha,
  TEST_NAME,
  type TestDefinition,
  type TestRun,
  type TestRunDetail,
  type TestRunPage,
  type TestsOverview,
} from "../client/testing";
import { globalOutput, printList, printMutation, printObject, resolveFormat, type OutputFormat } from "../ui/output";
import { confirmOrExit } from "../ui/prompt";
import { badUsage, parseEnum } from "../util/parse-flag";
import { parseLimit } from "../util/parse-limit";
import { parseInputs } from "../util/test-inputs";
import { followRun, streamLogs, type FollowDeps } from "./tests-follow";
import { registerTestFiles } from "./tests-files";
import { readOriginRemote } from "./up";

const REPO_HELP = "linked repository (owner/name or id; default: the git origin remote)";
const RUNS_HARD_LIMIT = 200;
const DETACHED_EXIT = 130;
const TRUST_WARNING = (repo: string): string =>
  `Anyone who can push to ${repo} will be able to run commands on machines in your cloud account. Reoclo records who enabled this.`;

const collect = (value: string, previous: string[]): string[] => [...previous, value];
const out = (line: string): void => void process.stdout.write(`${line}\n`);
const err = (line: string): void => void process.stderr.write(`${line}\n`);

async function askCancel(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return new Promise((resolve) => {
    rl.once("SIGINT", () => { rl.close(); resolve(false); });
    rl.question("cancel this test run? [y/N]: ", (answer) => { rl.close(); resolve(/^y(es)?$/i.test(answer.trim())); });
  });
}

function interactiveDeps(client: HttpClient, tid: string, write: (line: string) => void): { deps: FollowDeps; dispose: () => void } {
  let flag = false;
  let wake: (() => void) | null = null;
  const onSigint = (): void => { flag = true; wake?.(); };
  process.on("SIGINT", onSigint);
  const deps: FollowDeps = {
    client,
    tid,
    write,
    sleep: (ms) => new Promise<void>((resolve) => {
      const finish = (): void => { clearTimeout(timer); wake = null; resolve(); };
      const timer = setTimeout(finish, ms);
      wake = finish;
    }),
    interrupted: () => { const was = flag; flag = false; return was; },
    askCancel,
  };
  return { deps, dispose: () => process.off("SIGINT", onSigint) };
}

function triggers(d: TestDefinition): string {
  const on = d.spec?.on;
  if (!on) return "";
  const push = on.push ? [`push ${on.push.branches.join(" ")}`] : [];
  return [...(on.manual === false ? [] : ["manual"]), ...push].join(", ");
}

function runRow(r: TestRun): Record<string, unknown> {
  return { ...r, commit: shortSha(r.commit_sha), duration: elapsed(r.started_at, r.finished_at), started_at: r.started_at ?? "" };
}

function printRun(run: TestRunDetail, fmt: OutputFormat): void {
  if (fmt !== "text") {
    printObject({ ...run }, fmt);
    return;
  }
  printObject(
    {
      run: `#${run.number}`,
      id: run.id,
      test: run.test_name,
      state: run.state,
      ref: run.ref,
      commit: shortSha(run.commit_sha),
      trigger: run.trigger,
      created: run.created_at,
      duration: elapsed(run.started_at, run.finished_at),
      ...(run.error ? { error: run.error } : {}),
    },
    fmt,
  );
  out("");
  printList(
    run.jobs.map((j) => ({
      key: j.key,
      state: j.wait_reason ? `${j.state} (${j.wait_reason})` : j.state,
      steps: `${j.step_results.filter((s) => s.state === "passed").length}/${j.step_results.length}`,
      exit: j.exit_code ?? "",
      duration: elapsed(j.started_at, j.finished_at),
      needs: j.needs.join(", "),
    })),
    [
      { key: "key", label: "JOB" },
      { key: "state", label: "STATE" },
      { key: "steps", label: "STEPS PASSED" },
      { key: "exit", label: "EXIT" },
      { key: "duration", label: "DURATION" },
      { key: "needs", label: "NEEDS" },
    ],
    fmt,
  );
}

export function registerTests(program: Command): void {
  const g = program.command("tests").description("test files and test runs on test servers");
  const scope = async (): Promise<{ client: HttpClient; tid: string }> => {
    const ctx = await bootstrap();
    return { client: ctx.client, tid: await requireTenantId(ctx) };
  };

  g.command("ls")
    .description("list the test files on the repository's default branch")
    .option("--repo <repo>", REPO_HELP)
    .option("--refresh", "re-read the test files from the default branch first")
    .action(async (opts: { repo?: string; refresh?: boolean }) => {
      const fmt = resolveFormat(globalOutput(program));
      const { client, tid } = await scope();
      const repo = await resolveTestRepository(client, tid, opts.repo, readOriginRemote);
      const base = `/tenants/${tid}/repositories/${repo.id}/tests`;
      const overview = opts.refresh ? await client.post<TestsOverview>(`${base}/refresh`) : await client.get<TestsOverview>(base);
      const rows = overview.definitions.map((d) => ({
        ...d,
        pool: d.spec?.pool ?? "",
        triggers: triggers(d),
        jobs: d.spec?.jobs ? Object.keys(d.spec.jobs).length : "",
        commit: shortSha(d.sha),
        status: d.validation_error ?? "valid",
      }));
      printList(
        rows as unknown as Array<Record<string, unknown>>,
        [
          { key: "name", label: "NAME" },
          { key: "pool", label: "POOL" },
          { key: "triggers", label: "TRIGGERS" },
          { key: "jobs", label: "JOBS" },
          { key: "commit", label: "COMMIT" },
          { key: "status", label: "STATUS" },
        ],
        fmt,
      );
      if (overview.definitions.length === 0 && fmt === "text") {
        err("no test files on the default branch. Test files live in ci/reoclo/tests/<name>.yml; 'reoclo tests init <name>' writes one.");
      }
      if (!overview.tests_enabled && fmt === "text") {
        err(`tests are not enabled for ${repo.label}. An organization admin can run: reoclo tests enable --repo ${repo.label}`);
      }
    });

  for (const enable of [true, false]) {
    g.command(enable ? "enable" : "disable")
      .description(enable ? "allow test runs from a repository (organization admins only)" : "stop new test runs from a repository")
      .option("--repo <repo>", REPO_HELP)
      .option("--yes", "skip the confirmation prompt")
      .action(async (opts: { repo?: string; yes?: boolean }) => {
        const { client, tid } = await scope();
        const repo = await resolveTestRepository(client, tid, opts.repo, readOriginRemote);
        if (enable) {
          err(TRUST_WARNING(repo.label));
          await confirmOrExit(`enable tests for ${repo.label}? [y/N]: `, opts.yes);
        }
        const overview = await client.patch<TestsOverview>(`/tenants/${tid}/repositories/${repo.id}/test-settings`, { enabled: enable });
        printMutation(program, { ...overview }, `✓ tests ${enable ? "enabled" : "disabled"} for ${repo.label}`);
      });
  }

  g.command("run <name>")
    .description("start a run of a test file (exit 0 passed, 1 failed, 2 errored or cancelled, with --wait)")
    .option("--repo <repo>", REPO_HELP)
    .option("--ref <branch>", "branch to test (default: the repository's default branch)")
    .option("--sha <sha>", "commit to test (default: the head of the branch)")
    .option("--input <KEY=VALUE>", "value for an input the test file declares (repeatable)", collect, [] as string[])
    .option("--wait", "follow the run, print the job logs and exit with its result; Ctrl+C asks whether to cancel it")
    .action(async (name: string, opts: { repo?: string; ref?: string; sha?: string; input: string[]; wait?: boolean }) => {
      if (!TEST_NAME.test(name)) throw badUsage(`invalid test name '${name}' (lowercase letters, digits and dashes)`);
      if (opts.sha !== undefined && !/^[0-9a-f]{7,64}$/i.test(opts.sha)) throw badUsage(`invalid --sha: '${opts.sha}'`);
      const inputs = parseInputs(opts.input);
      const fmt = resolveFormat(globalOutput(program));
      const { client, tid } = await scope();
      const repo = await resolveTestRepository(client, tid, opts.repo, readOriginRemote);
      const body = {
        ...(opts.ref === undefined ? {} : { ref: opts.ref }),
        ...(opts.sha === undefined ? {} : { sha: opts.sha.toLowerCase() }),
        ...(Object.keys(inputs).length === 0 ? {} : { inputs }),
      };
      const run = await client.post<TestRun>(`/tenants/${tid}/repositories/${repo.id}/tests/${name}/runs`, body);
      const started = `run #${run.number} started: ${run.test_name} at ${shortSha(run.commit_sha)} (${run.ref})`;
      if (!opts.wait) {
        printMutation(program, { ...run }, `✓ ${started}, id: ${run.id}`);
        return;
      }
      const write = fmt === "text" ? out : err;
      write(started);
      const { deps, dispose } = interactiveDeps(client, tid, write);
      const result = await followRun(deps, run.id).finally(dispose);
      if (fmt !== "text") printObject({ ...result.run }, fmt);
      if (result.detached) {
        err(`stopped waiting; run #${run.number} is still going. Follow it with: reoclo tests logs ${run.number} --follow`);
        process.exitCode = DETACHED_EXIT;
        return;
      }
      write(`run #${run.number} ${result.run.state} in ${elapsed(result.run.started_at ?? result.run.created_at, result.run.finished_at)}`);
      process.exitCode = runExitCode(result.run.state) ?? 1;
    });

  g.command("runs")
    .description("list test runs, newest first")
    .option("--repo <repo>", "only runs of this repository (owner/name or id)")
    .option("--test <name>", "only runs of this test")
    .option("--state <state>", `only runs in this state: ${RUN_STATES.join(", ")}`)
    .option("--limit <n>", "runs to list", "20")
    .action(async (opts: { repo?: string; test?: string; state?: string; limit: string }) => {
      const state = opts.state === undefined ? undefined : parseEnum(opts.state, RUN_STATES, "--state");
      const limit = parseLimit(opts.limit, RUNS_HARD_LIMIT);
      const fmt = resolveFormat(globalOutput(program));
      const { client, tid } = await scope();
      const params = new URLSearchParams();
      if (opts.repo !== undefined) params.set("repository_id", (await resolveTestRepository(client, tid, opts.repo, readOriginRemote)).id);
      if (opts.test !== undefined) params.set("test", opts.test);
      if (state !== undefined) params.set("state", state);
      const runs: TestRun[] = [];
      for (let cursor: number | null = null; runs.length < limit; ) {
        const query = new URLSearchParams(params);
        if (cursor !== null) query.set("cursor", String(cursor));
        const page: TestRunPage = await client.get<TestRunPage>(`/tenants/${tid}/test-runs?${query.toString()}`);
        runs.push(...page.items);
        cursor = page.next_cursor;
        if (cursor === null) break;
      }
      printList(
        runs.slice(0, limit).map(runRow),
        [
          { key: "number", label: "RUN" },
          { key: "test_name", label: "TEST" },
          { key: "state", label: "STATE" },
          { key: "ref", label: "REF" },
          { key: "commit", label: "COMMIT" },
          { key: "trigger", label: "TRIGGER" },
          { key: "created_at", label: "CREATED" },
          { key: "duration", label: "DURATION" },
          { key: "id", label: "ID" },
        ],
        fmt,
      );
    });

  g.command("show <run>")
    .description("show one run with its jobs (run id or number)")
    .action(async (ref: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const { client, tid } = await scope();
      const id = await resolveTestRun(client, tid, ref);
      printRun(await client.get<TestRunDetail>(`/tenants/${tid}/test-runs/${id}`), fmt);
    });

  g.command("logs <run>")
    .description("print the logs of a run's jobs (run id or number)")
    .option("--job <key>", "only this job (key or id)")
    .option("--follow", "keep printing until the run finishes (polls every 2 seconds)")
    .action(async (ref: string, opts: { job?: string; follow?: boolean }) => {
      const { client, tid } = await scope();
      const id = await resolveTestRun(client, tid, ref);
      const { deps, dispose } = interactiveDeps(client, tid, out);
      await streamLogs(deps, id, opts.job, opts.follow === true).finally(dispose);
    });

  g.command("cancel <run>")
    .description("cancel a queued or running test run (run id or number)")
    .action(async (ref: string) => {
      const { client, tid } = await scope();
      const id = await resolveTestRun(client, tid, ref);
      const run = await client.post<TestRun>(`/tenants/${tid}/test-runs/${id}/cancel`);
      printMutation(program, { ...run }, `✓ cancel requested: run #${run.number} (${run.state})`);
    });

  g.command("rerun <run>")
    .description("start a new run of the same test at the same commit (run id or number)")
    .action(async (ref: string) => {
      const { client, tid } = await scope();
      const id = await resolveTestRun(client, tid, ref);
      const run = await client.post<TestRun>(`/tenants/${tid}/test-runs/${id}/rerun`);
      printMutation(program, { ...run }, `✓ run #${run.number} started: ${run.test_name} at ${shortSha(run.commit_sha)} (${run.ref}), id: ${run.id}`);
    });

  registerTestFiles(g, program);
}
