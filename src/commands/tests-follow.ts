// src/commands/tests-follow.ts
import type { ApiClient } from "../client/api-client";
import {
  drainJobLogs,
  isTerminalJob,
  isTerminalRun,
  LOG_START,
  pickJobs,
  type TestJob,
  type TestRunDetail,
} from "../client/testing";

export interface FollowDeps {
  client: ApiClient;
  tid: string;
  write: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** True when Ctrl+C was pressed since the last call; reading clears it. */
  interrupted: () => boolean;
  askCancel: () => Promise<boolean>;
}

export interface FollowResult { run: TestRunDetail; detached: boolean }

export const POLL_MS = 2000;

function jobLine(job: TestJob): string {
  const reason = job.wait_reason ? ` (${job.wait_reason})` : "";
  const exit = isTerminalJob(job.state) && job.exit_code !== null ? ` (exit ${job.exit_code})` : "";
  const error = job.error ? `: ${job.error}` : "";
  return `job ${job.key}: ${job.state}${reason}${exit}${error}`;
}

class JobPrinter {
  private readonly cursor = new Map<string, number>();
  private readonly state = new Map<string, string>();
  private readonly steps = new Map<string, string>();
  private readonly lastStep = new Map<string, number>();

  constructor(private readonly deps: FollowDeps, private readonly multi: boolean) {}

  private line(job: TestJob, text: string): void {
    this.deps.write(this.multi ? `[${job.key}] ${text}` : text);
  }

  private announce(job: TestJob): void {
    const key = `${job.state}|${job.wait_reason ?? ""}`;
    if (this.state.get(job.id) === key) return;
    this.state.set(job.id, key);
    this.line(job, jobLine(job));
  }

  async drain(job: TestJob): Promise<void> {
    const next = await drainJobLogs(this.deps.client, this.deps.tid, job, this.cursor.get(job.id) ?? LOG_START, (entry) => {
      if (this.lastStep.get(job.id) !== entry.step) {
        this.lastStep.set(job.id, entry.step);
        const name = job.step_results.find((s) => s.index === entry.step)?.name;
        this.line(job, `step ${entry.step + 1}${name ? ` ${name}` : ""}`);
      }
      this.line(job, entry.text);
    });
    this.cursor.set(job.id, next);
  }

  async report(job: TestJob): Promise<void> {
    if (!isTerminalJob(job.state)) this.announce(job);
    await this.drain(job);
    for (const step of job.step_results) {
      const key = `${job.id}:${step.index}`;
      if (step.state === "pending" || step.state === "running" || this.steps.get(key) === step.state) continue;
      this.steps.set(key, step.state);
      const exit = step.state === "failed" && step.exit_code !== null ? ` (exit ${step.exit_code})` : "";
      this.line(job, `step ${step.index + 1} ${step.name}: ${step.state}${exit}`);
    }
    if (isTerminalJob(job.state)) this.announce(job);
  }
}

/** Follow a run until it finishes, printing each job and step as it changes and the job logs. */
export async function followRun(deps: FollowDeps, runId: string): Promise<FollowResult> {
  const runPath = `/tenants/${deps.tid}/test-runs/${runId}`;
  let printer: JobPrinter | null = null;
  let announced = "";
  for (;;) {
    const run = await deps.client.get<TestRunDetail>(runPath);
    printer ??= new JobPrinter(deps, run.jobs.length > 1);
    const announce = (): void => {
      if (run.state === announced) return;
      announced = run.state;
      deps.write(`run #${run.number} ${run.state}`);
    };
    if (!isTerminalRun(run.state)) announce();
    for (const job of run.jobs) await printer.report(job);
    if (isTerminalRun(run.state)) {
      announce();
      if (run.error) deps.write(`run error: ${run.error}`);
      return { run, detached: false };
    }
    if (deps.interrupted()) {
      const cancel = await deps.askCancel();
      deps.interrupted();
      if (!cancel) return { run, detached: true };
      await deps.client.post(`${runPath}/cancel`);
      deps.write(`cancel requested for run #${run.number}`);
    }
    await deps.sleep(POLL_MS);
  }
}

/** Print the logs of a run's jobs; with `follow`, keep printing until the run ends. */
export async function streamLogs(deps: FollowDeps, runId: string, jobRef: string | undefined, follow: boolean): Promise<void> {
  const runPath = `/tenants/${deps.tid}/test-runs/${runId}`;
  let printer: JobPrinter | null = null;
  for (;;) {
    const run = await deps.client.get<TestRunDetail>(runPath);
    const jobs = pickJobs(run, jobRef);
    printer ??= new JobPrinter(deps, jobs.length > 1);
    for (const job of jobs) await printer.drain(job);
    if (!follow || isTerminalRun(run.state)) return;
    await deps.sleep(POLL_MS);
  }
}
