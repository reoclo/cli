// src/commands/up.ts
//
// `reoclo up`: point at a linked repository and deploy it. Finds the stack or
// application that already deploys the repository, or creates one on the first
// run, then deploys and waits.
import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { requireCapability, withCompletion } from "../client/command-meta";
import type { ApiClient } from "../client/api-client";
import { EXIT } from "../client/exit-codes";
import {
  createApp,
  createStack,
  exitError,
  listAll,
  listRepositories,
  scanRepository,
  selectDockerfileService,
} from "../client/repo-deploy";
import { resolveServer } from "../client/resolve";
import type { Application, Repository, WizardCreateResponse } from "../client/types";
import { defaultIo, type WaitDeps } from "../ui/deploy-io";
import { globalOutput, resolveFormat, type OutputFormat } from "../ui/output";
import { parseGitRemote } from "../util/git-remote";
import { assertDeploySucceeded, deployApp, type AppDeployResult } from "./apps";
import { deployStack, stackCreatedLines, type GroupRead, type StackDeployResult } from "./groups";

export interface UpFlags {
  repo?: string;
  server?: string;
  branch?: string;
  composeFile?: string;
  service?: string;
  name?: string;
  /** commander sets this from --no-wait; true unless the flag is given. */
  wait: boolean;
  forceRecreate?: boolean;
  waitTimeout: string;
}

export interface UpDeps extends WaitDeps {
  resolveServerId: (ref: string) => Promise<string>;
  readOriginRemote?: () => string | null;
  log?: (line: string) => void;
}

type Target = { kind: "stack"; group: GroupRead } | { kind: "app"; app: Application };

export function readOriginRemote(cwd: string = process.cwd()): string | null {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

function misuse(message: string): Error & { exitCode: number } {
  return exitError(message, EXIT.MISUSE);
}

function notLinked(ref: string): Error & { exitCode: number } {
  const hint = /^[^/\s]+\/[^/\s]+$/.test(ref) ? ref : "<owner/name>";
  return exitError(
    `repository '${ref}' is not linked to Reoclo. Link it first with 'reoclo repos link ${hint}'.`,
    EXIT.NOT_FOUND,
  );
}

export async function findRepository(
  client: ApiClient,
  tid: string,
  repoFlag: string | undefined,
  readRemote: () => string | null,
): Promise<Repository> {
  const repos = await listRepositories(client, tid);
  if (repoFlag !== undefined) {
    const lower = repoFlag.toLowerCase();
    const found =
      repos.find((r) => r.id === repoFlag) ??
      repos.find((r) => r.full_name.toLowerCase() === lower);
    if (found) return found;
    const byName = repos.filter((r) => r.name.toLowerCase() === lower);
    const [only] = byName;
    if (byName.length === 1 && only) return only;
    throw notLinked(repoFlag);
  }
  const remote = readRemote();
  if (remote === null) {
    throw misuse(
      "no git 'origin' remote found here. Run this inside a checkout or pass --repo <owner/name>.",
    );
  }
  const fullName = parseGitRemote(remote);
  if (fullName === null) {
    throw misuse(`cannot read a repository name from the origin remote '${remote}'. Pass --repo <owner/name>.`);
  }
  const found = repos.find((r) => r.full_name.toLowerCase() === fullName.toLowerCase());
  if (!found) throw notLinked(fullName);
  return found;
}

function normalizePath(path: string | null | undefined): string {
  return (path ?? "").replace(/^\.\//, "");
}

export async function findExistingTarget(
  client: ApiClient,
  tid: string,
  repository: Repository,
  flags: Pick<UpFlags, "composeFile" | "service">,
): Promise<Target | null> {
  if (flags.service === undefined) {
    const groups = await listAll<GroupRead>(client, `/tenants/${tid}/application-groups/`);
    const stacks = groups.filter(
      (g) =>
        g.kind === "compose" &&
        g.repository_id === repository.id &&
        (flags.composeFile === undefined ||
          normalizePath(g.compose_file_path) === normalizePath(flags.composeFile)),
    );
    const [only] = stacks;
    if (stacks.length === 1 && only) return { kind: "stack", group: only };
    if (stacks.length > 1) {
      const list = stacks.map((g) => `${g.slug} (${g.compose_file_path ?? "no compose file"})`);
      throw misuse(
        `several stacks deploy ${repository.full_name}: ${list.join(", ")}. Pass --compose-file to choose one.`,
      );
    }
  }
  if (flags.composeFile !== undefined) return null;
  const all = await listAll<Application>(client, `/tenants/${tid}/applications/`);
  const apps = all.filter(
    (a) =>
      a.repository_id === repository.id &&
      !a.group_id &&
      (flags.service === undefined || a.slug === flags.service || a.name === flags.service),
  );
  const [only] = apps;
  if (apps.length === 1 && only) return { kind: "app", app: only };
  if (apps.length > 1) {
    throw misuse(
      `several applications deploy ${repository.full_name}: ${apps.map((a) => a.slug).join(", ")}. Pass --service to choose one.`,
    );
  }
  return null;
}

interface Resolved {
  action: "deploy" | "create";
  kind: "stack" | "app";
  id: string;
  slug: string;
  created: WizardCreateResponse | null;
  createdLines: string[];
}

async function createTarget(
  client: ApiClient,
  tid: string,
  repository: Repository,
  flags: UpFlags,
  deps: UpDeps,
): Promise<Resolved> {
  if (flags.server === undefined) {
    throw misuse(
      `${repository.full_name} has no stack or application yet. Pass --server <server> to create one.`,
    );
  }
  const serverId = await deps.resolveServerId(flags.server);
  const scan = await scanRepository(client, tid, repository.id, { ref: flags.branch });
  if (scan.compose_files.length > 0 && flags.service === undefined) {
    const stack = await createStack(
      client,
      tid,
      {
        repositoryId: repository.id,
        repositoryName: repository.name,
        serverId,
        composeFile: flags.composeFile,
        branch: flags.branch,
        name: flags.name,
      },
      scan,
    );
    return {
      action: "create",
      kind: "stack",
      id: stack.groupId,
      slug: stack.response.group?.slug ?? "",
      created: stack.response,
      createdLines: stackCreatedLines(stack),
    };
  }
  const service = selectDockerfileService(
    { ...scan, services: scan.services.filter((s) => !s.compose_service) },
    flags.service,
  );
  const app = await createApp(client, tid, {
    repositoryId: repository.id,
    serverId,
    service,
    name: flags.name,
    branch: flags.branch,
  });
  const slug = app.response.created[0]?.slug ?? "";
  return {
    action: "create",
    kind: "app",
    id: app.appId,
    slug,
    created: app.response,
    createdLines: [`\u2713 created application ${slug} (id: ${app.appId})`],
  };
}

export async function runUp(
  client: ApiClient,
  tid: string,
  flags: UpFlags,
  fmt: OutputFormat,
  deps: UpDeps,
): Promise<void> {
  const io = deps.io ?? defaultIo;
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const text = fmt === "text";
  const repository = await findRepository(
    client,
    tid,
    flags.repo,
    deps.readOriginRemote ?? readOriginRemote,
  );
  const existing = await findExistingTarget(client, tid, repository, flags);

  let resolved: Resolved;
  if (existing) {
    const isStack = existing.kind === "stack";
    const slug = isStack ? existing.group.slug : existing.app.slug;
    resolved = {
      action: "deploy",
      kind: existing.kind,
      id: isStack ? existing.group.id : existing.app.id,
      slug,
      created: null,
      createdLines: [`deploying existing ${isStack ? "stack" : "application"} ${slug}`],
    };
    if (isStack && flags.branch !== undefined && flags.branch !== existing.group.deploy_branch) {
      log(
        `note: --branch only applies when a stack is created; ${slug} deploys ${existing.group.deploy_branch ?? "the default branch"}`,
      );
    }
  } else {
    resolved = await createTarget(client, tid, repository, flags, deps);
  }
  if (text) for (const line of resolved.createdLines) io.line(line);

  const timeoutSeconds = Number(flags.waitTimeout);
  const waitDeps: WaitDeps = { sleep: deps.sleep, now: deps.now, io };
  const deploy = async (): Promise<StackDeployResult | AppDeployResult> => {
    if (resolved.kind === "stack") {
      return deployStack(
        client,
        tid,
        resolved.id,
        {
          forceRecreate: flags.forceRecreate,
          wait: flags.wait,
          waitTimeoutSeconds: timeoutSeconds,
          fmt,
          quiet: !text,
        },
        waitDeps,
      );
    }
    const result = await deployApp(
      client,
      tid,
      resolved.id,
      {
        forceRecreate: flags.forceRecreate,
        ref: resolved.action === "deploy" ? flags.branch : undefined,
        wait: flags.wait,
        timeoutSeconds,
        quiet: !text,
      },
      waitDeps,
    );
    assertDeploySucceeded(result);
    return result;
  };

  if (text) {
    await deploy();
    return;
  }
  let deployment: StackDeployResult | AppDeployResult | null = null;
  let failure: Error | null = null;
  try {
    deployment = await deploy();
  } catch (e) {
    failure = e instanceof Error ? e : new Error(String(e));
  }
  io.object(
    {
      repository: { id: repository.id, full_name: repository.full_name },
      action: resolved.action,
      kind: resolved.kind,
      target: { id: resolved.id, slug: resolved.slug },
      created: resolved.created,
      deployment,
      deployment_error: failure?.message ?? null,
    },
    fmt,
  );
  if (failure) throw failure;
}

export function registerUp(program: Command): void {
  const cmd = program
    .command("up")
    .description("deploy a linked repository: find or create its stack or app, then deploy and wait")
    .option("--repo <repo>", "linked repository (owner/name, slug or id; default: the git origin remote)")
    .option("--server <server>", "server to create the stack or app on (needed on the first run)")
    .option("--branch <branch>", "branch to scan and deploy when creating (default: the default branch)")
    .option("--compose-file <path>", "compose file to deploy (needed when the repository has several)")
    .option("--service <name>", "Dockerfile service to deploy as an app (needed when there are several)")
    .option("--name <name>", "name for a stack or app created on the first run")
    .option("--no-wait", "return right after the deployment is triggered")
    .option(
      "--force-recreate",
      "recreate containers even when the image and configuration did not change",
    )
    .option("--wait-timeout <seconds>", "give up waiting after this long (default 600)", "600")
    .action(async (opts: UpFlags) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      await runUp(ctx.client, tid, opts, fmt, {
        resolveServerId: (ref) => resolveServer(ctx.client, tid, ref),
      });
    });
  requireCapability(cmd, "app:deploy");
  withCompletion(cmd, { flags: { "--server": "servers", "--repo": "repos" } });
}
