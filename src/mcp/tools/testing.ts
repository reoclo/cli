/**
 * Test server tools: test pools and their machines, test files, runs and job logs.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { exitError } from "../../client/repo-deploy";
import { EXIT } from "../../client/exit-codes";
import { LimitSchema } from "../../client/enums";
import {
  resolveTestPool,
  resolveTestRepository,
  resolveTestRun,
  RUN_STATES,
  type TestLogPage,
  type TestRunDetail,
} from "../../client/testing";
import type { McpRegistrationContext, OrgScope } from "./context";
import { asToolError, asToolResult } from "./common";

const noRemote = (): null => null;
const LOG_PAGE_MAX = 5000;

export function registerTestingTools(server: McpServer, ctx: McpRegistrationContext): void {
  const repository = z.string().min(1).describe("Repository as owner/name, or its id");
  const run = z.string().min(1).describe("Test run id, or its number such as 12");

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    handler: (scope: OrgScope, args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ): void => {
    const schema: z.ZodRawShape = { ...ctx.orgParam, ...shape };
    server.tool(name, description, schema, async (args) => {
      try {
        const scope = await ctx.resolveOrg(args["organization"]);
        return asToolResult(await handler(scope, args as z.infer<z.ZodObject<S>>));
      } catch (error: unknown) {
        return asToolError(error);
      }
    });
  };

  tool("list_test_pools", "List test pools (the machines that run test files)", { limit: LimitSchema.optional().describe("Max results (default 20)") },
    ({ tenantId, client }, { limit }) => client.get(`/tenants/${tenantId}/test-pools${limit ? `?limit=${limit}` : ""}`));

  tool("get_test_pool", "Get one test pool: machine type, limits, budget, and variable names (secret values are never returned)",
    { pool: z.string().min(1).describe("Test pool slug or id") },
    async ({ tenantId, client }, { pool }) => client.get(`/tenants/${tenantId}/test-pools/${await resolveTestPool(client, tenantId, pool)}`));

  tool("list_test_pool_machines", "List the machines a test pool has created, newest first",
    { pool: z.string().min(1).describe("Test pool slug or id"), limit: LimitSchema.optional().describe("Max results (default 20)") },
    async ({ tenantId, client }, { pool, limit }) =>
      client.get(`/tenants/${tenantId}/test-pools/${await resolveTestPool(client, tenantId, pool)}/machines${limit ? `?limit=${limit}` : ""}`));

  tool("list_tests", "List the test files on a repository's default branch with their validation result, and whether tests are enabled",
    { repository, refresh: z.boolean().optional().describe("Re-read the test files from the default branch first") },
    async ({ tenantId, client }, { repository: repo, refresh }) => {
      const found = await resolveTestRepository(client, tenantId, repo, noRemote);
      const path = `/tenants/${tenantId}/repositories/${found.id}/tests`;
      return refresh ? client.post(`${path}/refresh`) : client.get(path);
    });

  tool("set_repository_tests",
    "Enable or disable test runs for a repository (organization admins only). Enabling lets anyone who can push to the repository run commands on machines in the organization's cloud account, so enable it only when the user asked for it and trusts the repository.",
    { repository, enabled: z.boolean().describe("true to allow test runs, false to stop new ones") },
    async ({ tenantId, client }, { repository: repo, enabled }) => {
      const found = await resolveTestRepository(client, tenantId, repo, noRemote);
      return client.patch(`/tenants/${tenantId}/repositories/${found.id}/test-settings`, { enabled });
    });

  tool("start_test_run", "Start a run of a test file. Tests must be enabled for the repository; the test must allow manual runs. Pass inputs for the values the test file declares under on.manual.inputs; an unknown name or a missing required input is refused with a message that names it.",
    {
      repository,
      test: z.string().min(1).describe("Test name (the file name without .yml)"),
      ref: z.string().min(1).optional().describe("Branch to test (default: the repository's default branch)"),
      sha: z.string().regex(/^[0-9a-f]{7,64}$/).optional().describe("Commit to test (default: the head of the branch)"),
      inputs: z.record(z.string(), z.string()).optional().describe("Values for the inputs the test file declares, as name to value. Secret inputs are accepted too; their values are never shown back."),
    },
    async ({ tenantId, client }, { repository: repo, test, ref, sha, inputs }) => {
      const found = await resolveTestRepository(client, tenantId, repo, noRemote);
      return client.post(`/tenants/${tenantId}/repositories/${found.id}/tests/${encodeURIComponent(test)}/runs`, {
        ...(ref === undefined ? {} : { ref }),
        ...(sha === undefined ? {} : { sha }),
        ...(inputs === undefined || Object.keys(inputs).length === 0 ? {} : { inputs }),
      });
    });

  tool("list_test_runs", "List test runs, newest first, 50 per page; pass next_cursor as cursor for the next page",
    {
      repository: repository.optional(),
      test: z.string().min(1).optional().describe("Only runs of this test"),
      state: z.enum(RUN_STATES).optional().describe("Only runs in this state"),
      cursor: z.number().int().min(1).optional().describe("next_cursor from the previous page"),
    },
    async ({ tenantId, client }, { repository: repo, test, state, cursor }) => {
      const params = new URLSearchParams();
      if (repo) params.set("repository_id", (await resolveTestRepository(client, tenantId, repo, noRemote)).id);
      if (test) params.set("test", test);
      if (state) params.set("state", state);
      if (cursor) params.set("cursor", String(cursor));
      const qs = params.toString();
      return client.get(`/tenants/${tenantId}/test-runs${qs ? `?${qs}` : ""}`);
    });

  tool("get_test_run", "Get one test run with its jobs: state, steps, exit codes and errors",
    { run },
    async ({ tenantId, client }, { run: ref }) => client.get(`/tenants/${tenantId}/test-runs/${await resolveTestRun(client, tenantId, ref)}`));

  tool("get_test_job_logs",
    "Read the output of one job in a test run. Pass the returned next_after_seq as after_seq to read on while the job runs.",
    {
      run,
      job: z.string().min(1).optional().describe("Job key from the test file; optional when the run has one job"),
      after_seq: z.number().int().min(-1).optional().describe("Read lines after this sequence number (default: from the start)"),
      limit: z.number().int().min(1).max(LOG_PAGE_MAX).optional().describe("Max lines (default 500)"),
    },
    async ({ tenantId, client }, { run: ref, job, after_seq, limit }) => {
      const runId = await resolveTestRun(client, tenantId, ref);
      const detail = await client.get<TestRunDetail>(`/tenants/${tenantId}/test-runs/${runId}`);
      const found = job === undefined && detail.jobs.length === 1 ? detail.jobs[0] : detail.jobs.find((j) => j.key === job || j.id === job);
      if (!found) {
        throw exitError(`pass job as one of: ${detail.jobs.map((j) => j.key).join(", ")}`, EXIT.MISUSE);
      }
      const page = await client.get<TestLogPage>(
        `/tenants/${tenantId}/test-runs/${runId}/jobs/${found.id}/logs?after_seq=${after_seq ?? -1}&limit=${limit ?? 500}`,
      );
      return { job: found.key, job_state: found.state, run_state: detail.state, ...page };
    });

  tool("cancel_test_run", "Cancel a queued or running test run", { run },
    async ({ tenantId, client }, { run: ref }) => client.post(`/tenants/${tenantId}/test-runs/${await resolveTestRun(client, tenantId, ref)}/cancel`));

  tool("rerun_test_run", "Start a new run of the same test at the same commit as an earlier run", { run },
    async ({ tenantId, client }, { run: ref }) => client.post(`/tenants/${tenantId}/test-runs/${await resolveTestRun(client, tenantId, ref)}/rerun`));

  tool("validate_test_file", "Check the text of a test file against the API, without running it. Answers valid with a summary of the test, or the error.",
    {
      name: z.string().min(1).describe("Test name, the file name without .yml"),
      content: z.string().describe("The file's text"),
    },
    ({ tenantId, client }, { name, content }) => client.post(`/tenants/${tenantId}/tests/validate`, { name, content }));
}
