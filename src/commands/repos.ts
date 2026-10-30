// src/commands/repos.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { withCompletion } from "../client/command-meta";
import { resolveRepo } from "../client/resolve";
import type { ApiClient } from "../client/api-client";
import { EXIT } from "../client/exit-codes";
import {
  exitError,
  linkRepository,
  listRepositories,
  MAX_SCAN_CONFIG_PATHS,
  scanRepository,
  type LinkDeps,
} from "../client/repo-deploy";
import type { RepoScanResponse } from "../client/types";
import { cacheList } from "../completion/populate";
import { parseGitRemote } from "../util/git-remote";
import {
  globalOutput,
  printList,
  printObject,
  resolveFormat,
  type OutputFormat,
} from "../ui/output";

interface BranchInfo {
  name: string;
  is_default: boolean;
}

interface BranchListResponse {
  branches: BranchInfo[];
  default_branch: string;
}

export async function runReposLs(
  client: ApiClient,
  tid: string,
  search: string | undefined,
  fmt: OutputFormat,
): Promise<void> {
  const all = await listRepositories(client, tid, search);
  cacheList("repos", all);
  printList(
    all as unknown as Array<Record<string, unknown>>,
    [
      { key: "full_name", label: "NAME" },
      { key: "default_branch", label: "DEFAULT" },
      { key: "is_private", label: "PRIVATE" },
      { key: "last_push_at", label: "LAST PUSH" },
      { key: "status", label: "STATUS" },
    ],
    fmt,
  );
}

export function scanServiceRows(scan: RepoScanResponse): Array<Record<string, unknown>> {
  return scan.services.map((s) => ({
    name: s.name,
    source: s.source,
    build_pack: s.build_pack,
    compose_file: s.compose_file_path ?? "",
    service: s.compose_service ?? "",
    port: s.container_port ?? "",
    image: s.image ?? "",
  }));
}

export function printScan(scan: RepoScanResponse, fmt: OutputFormat): void {
  if (fmt !== "text") {
    printObject(scan as unknown as Record<string, unknown>, fmt);
    return;
  }
  printObject(
    {
      repository: scan.repository_id,
      ref: scan.ref,
      commit: scan.commit_sha.slice(0, 8),
      "compose files": scan.compose_files.length > 0 ? scan.compose_files.join(", ") : "none",
    },
    fmt,
  );
  if (scan.services.length > 0) {
    console.log("");
    printList(
      scanServiceRows(scan),
      [
        { key: "name", label: "NAME" },
        { key: "source", label: "SOURCE" },
        { key: "build_pack", label: "BUILD PACK" },
        { key: "compose_file", label: "COMPOSE FILE" },
        { key: "service", label: "SERVICE" },
        { key: "port", label: "PORT" },
        { key: "image", label: "IMAGE" },
      ],
      fmt,
    );
  } else {
    console.log("\nNo deployable services found.");
  }
  if (scan.skipped_services.length > 0) {
    console.log("");
    printList(
      scan.skipped_services.map((s) => ({ name: s.name, reason: s.reason })),
      [
        { key: "name", label: "SKIPPED" },
        { key: "reason", label: "REASON" },
      ],
      fmt,
    );
  }
  if (scan.deployment_configs.length > 0) {
    console.log("");
    printList(
      scan.deployment_configs.map((c) => ({
        path: c.path,
        label: c.label,
        valid: c.valid ? "yes" : (c.validation_error ?? "no"),
      })),
      [
        { key: "path", label: "DEPLOYMENT CONFIG" },
        { key: "label", label: "LABEL" },
        { key: "valid", label: "VALID" },
      ],
      fmt,
    );
  }
  const problems = scan.manual_configs.filter((m) => m.status !== "ok");
  if (problems.length > 0) {
    console.log("");
    printList(
      problems.map((m) => ({ path: m.requested_path, status: m.status, error: m.error ?? "" })),
      [
        { key: "path", label: "CONFIG PATH" },
        { key: "status", label: "STATUS" },
        { key: "error", label: "ERROR" },
      ],
      fmt,
    );
  }
}

export async function runReposScan(
  client: ApiClient,
  tid: string,
  repositoryId: string,
  opts: { ref?: string; config: string[] },
  fmt: OutputFormat,
): Promise<RepoScanResponse> {
  if (opts.config.length > MAX_SCAN_CONFIG_PATHS) {
    throw exitError(
      `at most ${MAX_SCAN_CONFIG_PATHS} --config paths are allowed, got ${opts.config.length}`,
      EXIT.MISUSE,
    );
  }
  const scan = await scanRepository(client, tid, repositoryId, {
    ref: opts.ref,
    configPaths: opts.config,
  });
  printScan(scan, fmt);
  return scan;
}

export function parseRepoFullName(input: string): string {
  const trimmed = input.trim();
  const parsed = parseGitRemote(trimmed);
  if (parsed) return parsed;
  if (/^[^/\s:@]+\/[^/\s]+$/.test(trimmed)) return trimmed.replace(/\.git$/, "");
  throw exitError(`'${input}' is not a repository name. Use owner/name.`, EXIT.MISUSE);
}

export async function runReposLink(
  client: ApiClient,
  tid: string,
  input: string,
  opts: { wait: boolean; waitTimeoutSeconds: number },
  fmt: OutputFormat,
  deps: LinkDeps = {},
): Promise<void> {
  const fullName = parseRepoFullName(input);
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const result = await linkRepository(client, tid, fullName, opts, { ...deps, log });
  if (result.repository) {
    if (fmt === "text") {
      const verb = result.alreadyLinked ? "is already linked" : "is linked";
      console.log(`✓ ${result.repository.full_name} ${verb} (id: ${result.repository.id})`);
    } else {
      printObject(result.repository as unknown as Record<string, unknown>, fmt);
    }
    return;
  }
  if (fmt === "text") {
    console.log(
      `✓ sync queued for ${fullName}; it appears in 'reoclo repos ls' once the sync finishes`,
    );
  } else {
    printObject({ full_name: fullName, status: "syncing", actions: result.actions }, fmt);
  }
}

export function registerRepos(program: Command): void {
  const g = program.command("repos").description("manage mirrored git repositories");

  g.command("ls")
    .description("list repositories")
    .option("--search <q>", "filter by repo name or full_name")
    .action(async (opts: { search?: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      await runReposLs(ctx.client, tid, opts.search, fmt);
    });

  withCompletion(
    g
      .command("get <repo>")
      .description("show one repository (accepts slug or id)")
      .action(async (repo: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const id = await resolveRepo(ctx.client, tid, repo);
        const r = await ctx.client.get<Record<string, unknown>>(
          `/tenants/${tid}/repositories/${id}`,
        );
        printObject(r, fmt);
      }),
    { args: [{ slot: 0, resource: "repos" }] },
  );

  withCompletion(
    g
      .command("scan <repo>")
      .description("show what a linked repository can deploy: compose files, services, ports")
      .option("--ref <branch>", "branch, tag or commit to scan (default: the default branch)")
      .option(
        "--config <path>",
        `extra config file path to resolve (repeatable, up to ${MAX_SCAN_CONFIG_PATHS})`,
        (val: string, prev: string[]) => [...prev, val],
        [] as string[],
      )
      .action(async (repo: string, opts: { ref?: string; config: string[] }) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const id = await resolveRepo(ctx.client, tid, repo);
        await runReposScan(ctx.client, tid, id, opts, fmt);
      }),
    { args: [{ slot: 0, resource: "repos" }] },
  );

  g.command("link <ownerName>")
    .description(
      "make a connected provider mirror a repository (GitHub selection or Gitea sync), then wait for it",
    )
    .option("--no-wait", "queue the sync and return without waiting")
    .option("--wait-timeout <seconds>", "give up waiting after this long (default 180)", "180")
    .action(async (ownerName: string, opts: { wait: boolean; waitTimeout: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      await runReposLink(
        ctx.client,
        tid,
        ownerName,
        { wait: opts.wait, waitTimeoutSeconds: Number(opts.waitTimeout) },
        fmt,
      );
    });

  withCompletion(
    g
      .command("branches <repo>")
      .description("list branches for a repository")
      .action(async (repo: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const id = await resolveRepo(ctx.client, tid, repo);
        const res = await ctx.client.get<BranchListResponse>(
          `/tenants/${tid}/repositories/${id}/branches`,
        );
        const rows = res.branches.map((b) => ({
          BRANCH: b.name,
          DEFAULT: b.is_default ? "✓" : "",
        }));
        printList(
          rows as unknown as Array<Record<string, unknown>>,
          [
            { key: "BRANCH", label: "BRANCH" },
            { key: "DEFAULT", label: "DEFAULT" },
          ],
          fmt,
        );
      }),
    { args: [{ slot: 0, resource: "repos" }] },
  );
}
