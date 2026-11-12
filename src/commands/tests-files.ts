// src/commands/tests-files.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { ApiError } from "../client/errors";
import { EXIT } from "../client/exit-codes";
import { exitError } from "../client/repo-deploy";
import { TEST_NAME, triggerList, type TestValidation, type ValidatedTest } from "../client/testing";
import { globalOutput, printList, resolveFormat } from "../ui/output";
import { badUsage } from "../util/parse-flag";

const TESTS_DIR = "ci/reoclo/tests";
const DEFAULT_POOL = "default";
const DEFAULT_IMAGE = "alpine:3";
const POOL_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const PLAIN_BRANCH = /^[A-Za-z0-9._/-]+$/;

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

function repoRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
}

function defaultBranch(cwd: string): string {
  const head = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return head?.replace(/^origin\//, "") ?? git(cwd, ["branch", "--show-current"]) ?? "main";
}

function starter(pool: string, image: string, branch: string): string {
  const branchText = PLAIN_BRANCH.test(branch) ? branch : JSON.stringify(branch);
  return [
    "version: 1",
    `pool: ${pool}`,
    "on:",
    "  manual: true",
    "  push:",
    `    branches: [${branchText}]`,
    "jobs:",
    "  test:",
    `    image: ${image}`,
    "    timeout_minutes: 20",
    "    steps:",
    "      - name: List the checkout",
    "        run: ls -la",
    "      - name: Run the tests",
    "        run: echo \"replace this step with your test command\"",
    "",
  ].join("\n");
}

function collectFiles(root: string, paths: string[]): string[] {
  const targets = paths.length > 0 ? paths : [join(root, TESTS_DIR)];
  const files: string[] = [];
  for (const target of targets) {
    const stat = statSync(target, { throwIfNoEntry: false });
    if (stat === undefined) {
      if (paths.length > 0) throw exitError(`no such file or directory: ${target}`, EXIT.NOT_FOUND);
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...readdirSync(target).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => join(target, f)));
    } else {
      files.push(target);
    }
  }
  if (files.length === 0) {
    throw exitError(`no test files found in ${TESTS_DIR}. Create one with 'reoclo tests init <name>'.`, EXIT.GENERIC);
  }
  return files;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function summarizeTest(test: ValidatedTest): string {
  const steps = test.jobs.reduce((sum, job) => sum + job.steps, 0);
  const triggers = triggerList({ ...test.on, inputs: (test.inputs ?? []).map((input) => input.name) });
  return `pool ${test.pool}, ${plural(test.jobs.length, "job")}, ${plural(steps, "step")}, on ${triggers.join(" and ") || "no trigger"}`;
}

export function registerTestFiles(g: Command, program: Command): void {
  g.command("init <name>")
    .description(`write a starter test file to ${TESTS_DIR}/<name>.yml in this repository`)
    .option("--pool <slug>", `slug of the test pool that runs it (default: ${DEFAULT_POOL}; set it to one of 'reoclo test-pools ls')`)
    .option("--image <image>", `container image the steps run in (default: ${DEFAULT_IMAGE})`)
    .option("--force", "overwrite an existing file")
    .action((name: string, opts: { pool?: string; image?: string; force?: boolean }) => {
      if (!TEST_NAME.test(name)) throw badUsage(`invalid test name '${name}' (lowercase letters, digits and dashes, up to 63 characters)`);
      const pool = opts.pool ?? DEFAULT_POOL;
      const image = opts.image ?? DEFAULT_IMAGE;
      if (!POOL_SLUG.test(pool)) throw badUsage(`invalid --pool: '${pool}'`);
      if (!IMAGE_REF.test(image)) throw badUsage(`invalid --image: '${image}'`);
      const cwd = process.cwd();
      const root = repoRoot(cwd);
      const path = join(root, TESTS_DIR, `${name}.yml`);
      const shown = relative(cwd, path);
      if (existsSync(path) && !opts.force) {
        throw exitError(`${shown} already exists; pass --force to overwrite it`, EXIT.GENERIC);
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, starter(pool, image, defaultBranch(root)));
      process.stdout.write(`✓ wrote ${shown}\n`);
      if (opts.pool === undefined) {
        process.stderr.write(`set 'pool:' to the slug of one of your test pools (reoclo test-pools ls), or pass --pool\n`);
      }
      process.stderr.write(`next: reoclo tests validate, commit and push the file, then reoclo tests run ${name} --wait\n`);
    });

  g.command("validate [paths...]")
    .description(`check test files against the API (default: every ${TESTS_DIR}/*.yml); exit 1 if any is invalid`)
    .action(async (paths: string[]) => {
      const fmt = resolveFormat(globalOutput(program));
      const cwd = process.cwd();
      const files = collectFiles(repoRoot(cwd), paths);
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const rows: Array<Record<string, unknown>> = [];
      for (const file of files) {
        const name = basename(file, extname(file));
        const content = readFileSync(file, "utf8");
        const result = await ctx.client
          .post<TestValidation>(`/tenants/${tid}/tests/validate`, { name, content })
          .catch((e: unknown): TestValidation => {
            if (e instanceof ApiError && e.status === 422) return { valid: false, error: e.message, test: null };
            throw e;
          });
        rows.push({ path: relative(cwd, file), name, ...result });
      }
      if (fmt === "text") {
        for (const row of rows) {
          const test = row["test"] as ValidatedTest | null;
          process.stdout.write(
            row["valid"] === true && test !== null
              ? `✓ ${String(row["path"])}: valid (${summarizeTest(test)})\n`
              : `✗ ${String(row["path"])}: invalid: ${String(row["error"])}\n`,
          );
        }
      } else {
        printList(rows, ["path", "name", "valid", "error", "test"], fmt);
      }
      if (rows.some((row) => row["valid"] !== true)) process.exitCode = EXIT.GENERIC;
    });
}
