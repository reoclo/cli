// src/client/testing.ts
//
// Test servers: wire types, identifier resolution and the helpers shared by the
// `test-pools` and `tests` commands and by the MCP tools.
import type { ApiClient } from "./api-client";
import { EXIT } from "./exit-codes";
import { isUuid } from "./resolve";
import { exitError, listRepositories } from "./repo-deploy";
import type { PaginatedResponse } from "./types";
import { parseGitRemote } from "../util/git-remote";
import { badUsage } from "../util/parse-flag";

export const RUN_STATES = ["queued", "running", "passed", "failed", "cancelling", "cancelled", "errored"] as const;
export type RunState = (typeof RUN_STATES)[number];

const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(["passed", "failed", "cancelled", "errored"]);
const TERMINAL_JOB_STATES: ReadonlySet<string> = new Set(["passed", "failed", "cancelled", "skipped", "errored"]);

export const TEST_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const isTerminalRun = (state: string): boolean => TERMINAL_RUN_STATES.has(state);
export const isTerminalJob = (state: string): boolean => TERMINAL_JOB_STATES.has(state);

/** Exit code a gating pipeline sees: 0 passed, 1 failed, 2 errored or cancelled. Null while the run is live. */
export function runExitCode(state: string): number | null {
  if (state === "passed") return EXIT.SUCCESS;
  if (state === "failed") return EXIT.GENERIC;
  if (state === "errored" || state === "cancelled") return EXIT.MISUSE;
  return null;
}

export interface TestVariable { key: string; secret: boolean; value: string | null }

export interface TestPool {
  id: string;
  name: string;
  slug: string;
  provider: string;
  cloud_credential_id: string;
  location: string;
  server_type: string;
  fallback_server_types: string[];
  arch: string;
  image: string | null;
  stock_image: string;
  volume_gb: number;
  max_machines: number;
  job_time_limit_minutes: number;
  monthly_budget_cents: number | null;
  budget_currency: string;
  variables: TestVariable[];
  live_machines: number;
  month_cost_cents: number | null;
}

export interface TestMachine {
  id: string;
  state: string;
  server_type: string;
  location: string | null;
  created_at: string;
  deleted_at: string | null;
  error_code: string | null;
  cost?: { currency: string; net_minor_units: number } | null;
}

export interface TestStepResult {
  index: number;
  name: string;
  state: string;
  exit_code: number | null;
}

export interface TestJob {
  id: string;
  run_id: string;
  key: string;
  needs: string[];
  image: string;
  state: string;
  wait_reason: string | null;
  exit_code: number | null;
  error: string | null;
  step_results: TestStepResult[];
  started_at: string | null;
  finished_at: string | null;
}

export interface TestRun {
  id: string;
  number: number;
  repository_id: string;
  test_name: string;
  commit_sha: string;
  ref: string;
  trigger: string;
  state: RunState;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface TestRunDetail extends TestRun { jobs: TestJob[] }
export interface TestRunPage { items: TestRun[]; next_cursor: number | null }

export interface TestLogLine { step: number; seq: number; ts: string; stream: string; text: string }
export interface TestLogPage { items: TestLogLine[]; next_after_seq: number }

export interface TestDefinition {
  name: string;
  path: string;
  sha: string;
  validation_error: string | null;
  spec: { pool?: string; on?: { manual?: boolean; push?: { branches: string[] } | null }; jobs?: Record<string, unknown> } | null;
}
export interface TestsOverview { tests_enabled: boolean; definitions: TestDefinition[] }

export interface ValidatedTest {
  name: string;
  pool: string;
  on: { manual: boolean; push: { branches: string[] } | null };
  jobs: Array<{ key: string; image: string; needs: string[]; steps: number }>;
  order: string[];
}
export interface TestValidation { valid: boolean; error: string | null; test: ValidatedTest | null }

export const LOG_START = -1;
const LOG_PAGE = 5000;
const POOL_PAGE = 100;

export async function listTestPools(client: ApiClient, tid: string): Promise<TestPool[]> {
  const out: TestPool[] = [];
  for (let skip = 0; ; skip += POOL_PAGE) {
    const res = await client.get<PaginatedResponse<TestPool>>(`/tenants/${tid}/test-pools?skip=${skip}&limit=${POOL_PAGE}`);
    out.push(...res.items);
    if (res.items.length < POOL_PAGE) return out;
  }
}

/** A test pool by id, slug or name. */
export async function resolveTestPool(client: ApiClient, tid: string, ref: string): Promise<string> {
  if (isUuid(ref)) return ref;
  const pools = await listTestPools(client, tid);
  const found = pools.find((p) => p.slug === ref) ?? pools.find((p) => p.name === ref);
  if (found) return found.id;
  const available = pools.map((p) => p.slug).join(", ");
  throw exitError(`test pool '${ref}' not found${available ? `. available: ${available}` : ""}`, EXIT.NOT_FOUND);
}

export interface TestRepository { id: string; label: string }

/** A linked repository from --repo (owner/name or id), or from the git origin remote when omitted. */
export async function resolveTestRepository(
  client: ApiClient,
  tid: string,
  repo: string | undefined,
  readRemote: () => string | null,
): Promise<TestRepository> {
  let wanted = repo;
  if (wanted === undefined) {
    const remote = readRemote();
    if (remote === null) {
      throw exitError("no git 'origin' remote found here. Run this inside a checkout or pass --repo <owner/name>.", EXIT.MISUSE);
    }
    wanted = parseGitRemote(remote) ?? undefined;
    if (wanted === undefined) {
      throw exitError(`cannot read a repository name from the origin remote '${remote}'. Pass --repo <owner/name>.`, EXIT.MISUSE);
    }
  }
  if (isUuid(wanted)) return { id: wanted, label: wanted };
  const lower = wanted.toLowerCase();
  const repos = await listRepositories(client, tid, lower.split("/").pop());
  const byName = wanted.includes("/") ? [] : repos.filter((r) => r.name.toLowerCase() === lower);
  const found = repos.find((r) => r.full_name.toLowerCase() === lower) ?? (byName.length === 1 ? byName[0] : undefined);
  if (!found) {
    const hint = wanted.includes("/") ? wanted : "<owner/name>";
    throw exitError(`repository '${wanted}' is not linked to Reoclo. Link it first with 'reoclo repos link ${hint}'.`, EXIT.NOT_FOUND);
  }
  return { id: found.id, label: found.full_name };
}

/** A test run by id or by its number (#12 or 12). */
export async function resolveTestRun(client: ApiClient, tid: string, ref: string): Promise<string> {
  if (isUuid(ref)) return ref;
  const match = /^#?(\d+)$/.exec(ref.trim());
  const number = match ? Number(match[1]) : 0;
  if (number < 1) throw badUsage(`invalid run '${ref}' (expected a run id or number)`);
  const page = await client.get<TestRunPage>(`/tenants/${tid}/test-runs?cursor=${number + 1}`);
  const run = page.items[0];
  if (run?.number === number) return run.id;
  throw exitError(`test run #${number} not found`, EXIT.NOT_FOUND);
}

/** The job named by `ref` (key or id), or every job of the run when `ref` is omitted. */
export function pickJobs(run: TestRunDetail, ref: string | undefined): TestJob[] {
  if (ref === undefined) return run.jobs;
  const job = run.jobs.find((j) => j.key === ref || j.id === ref);
  if (job) return [job];
  throw exitError(`job '${ref}' not found in run #${run.number}. jobs: ${run.jobs.map((j) => j.key).join(", ")}`, EXIT.NOT_FOUND);
}

/** Read every log line after `afterSeq`, page by page. Returns the cursor to resume from. */
export async function drainJobLogs(
  client: ApiClient,
  tid: string,
  job: Pick<TestJob, "id" | "run_id">,
  afterSeq: number,
  onLine: (line: TestLogLine) => void,
): Promise<number> {
  let cursor = afterSeq;
  for (;;) {
    const page = await client.get<TestLogPage>(
      `/tenants/${tid}/test-runs/${job.run_id}/jobs/${job.id}/logs?after_seq=${cursor}&limit=${LOG_PAGE}`,
    );
    for (const line of page.items) onLine(line);
    cursor = page.next_after_seq;
    if (page.items.length < LOG_PAGE) return cursor;
  }
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Elapsed time between two ISO timestamps as 1m05s, or an empty string while unknown. */
export function elapsed(start: string | null, end: string | null, now: number = Date.now()): string {
  if (start === null) return "";
  const seconds = Math.max(0, Math.round(((end === null ? now : Date.parse(end)) - Date.parse(start)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}
