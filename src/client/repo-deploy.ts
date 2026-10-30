// src/client/repo-deploy.ts
//
// Repository scan, link and wizard-setup flows behind `repos scan`,
// `repos link`, `stacks create` and `up`. They take an ApiClient and return
// data (or throw an error carrying an exit code), so the commands stay thin
// and the tests run against an in-memory client.
import type { ApiClient } from "./api-client";
import { ApiError, PermissionError } from "./errors";
import { EXIT } from "./exit-codes";
import type {
  DetectedService,
  GitHubAvailableRepo,
  GitHubInstallation,
  GitProvider,
  RepoScanResponse,
  Repository,
  WizardCreateRequest,
  WizardCreateResponse,
  WizardServiceCreate,
} from "./types";
import { realSleep } from "../ui/deploy-io";

export const DEFAULT_CONTAINER_PORT = 8080;
export const MAX_SCAN_CONFIG_PATHS = 5;

export function exitError(message: string, exitCode: number): Error & { exitCode: number } {
  const e = new Error(message) as Error & { exitCode: number };
  e.exitCode = exitCode;
  return e;
}

export async function listAll<T>(client: ApiClient, path: string): Promise<T[]> {
  const out: T[] = [];
  const limit = 200;
  const sep = path.includes("?") ? "&" : "?";
  for (let skip = 0; ; skip += limit) {
    const res = await client.get<T[] | { items: T[] }>(
      `${path}${sep}skip=${skip}&limit=${limit}`,
    );
    const items = Array.isArray(res) ? res : res.items;
    out.push(...items);
    if (items.length < limit) return out;
  }
}

export function listRepositories(
  client: ApiClient,
  tid: string,
  search?: string,
): Promise<Repository[]> {
  const q = search ? `?q=${encodeURIComponent(search)}` : "";
  return listAll<Repository>(client, `/tenants/${tid}/repositories/${q}`);
}

export function scanRepository(
  client: ApiClient,
  tid: string,
  repositoryId: string,
  opts: { ref?: string; configPaths?: string[] } = {},
): Promise<RepoScanResponse> {
  return client.post<RepoScanResponse>(`/tenants/${tid}/repositories/${repositoryId}/scan-services`, {
    ref: opts.ref ?? null,
    config_paths: opts.configPaths ?? [],
  });
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "");
}

export function pickComposeFile(scan: RepoScanResponse, requested?: string): string {
  const files = scan.compose_files;
  if (requested !== undefined) {
    const wanted = normalizePath(requested);
    const found = files.find((f) => normalizePath(f) === wanted);
    if (found) return found;
    throw exitError(
      files.length === 0
        ? `compose file '${requested}' not found: the repository has no compose file at ${scan.ref}`
        : `compose file '${requested}' not found at ${scan.ref}. found: ${files.join(", ")}`,
      EXIT.MISUSE,
    );
  }
  if (files.length === 0) {
    throw exitError(`no compose file found in the repository at ${scan.ref}`, EXIT.NOT_FOUND);
  }
  const [only] = files;
  if (files.length === 1 && only !== undefined) return only;
  throw exitError(
    `several compose files found at ${scan.ref}; pass --compose-file. found: ${files.join(", ")}`,
    EXIT.MISUSE,
  );
}

function toCreateEntry(s: DetectedService, serverId: string): WizardServiceCreate {
  const runsImage = s.build_pack === "docker_image" && !!s.compose_service && !!s.image;
  const entry: WizardServiceCreate = {
    action: "create",
    name: s.name,
    slug: s.suggested_slug,
    server_id: serverId,
    base_directory: s.base_directory,
    build_pack: runsImage ? "docker_image" : s.build_pack,
    container_port: s.container_port ?? DEFAULT_CONTAINER_PORT,
    deploy_branch: null,
    auto_deploy: true,
    linked_container_name: null,
    docker_image: runsImage ? (s.image ?? null) : null,
  };
  if (s.compose_file_path) entry.compose_file_path = s.compose_file_path;
  if (s.compose_service) entry.compose_service = s.compose_service;
  if (s.build_pack === "dockerfile" && s.dockerfile_path) entry.dockerfile_path = s.dockerfile_path;
  return entry;
}

export function stackServices(
  scan: RepoScanResponse,
  composeFile: string,
  serverId: string,
): WizardServiceCreate[] {
  const wanted = normalizePath(composeFile);
  const members = scan.services.filter(
    (s) =>
      s.compose_service !== null &&
      s.compose_file_path !== null &&
      normalizePath(s.compose_file_path) === wanted,
  );
  if (members.length === 0) {
    throw exitError(`no deployable services found in ${composeFile}`, EXIT.NOT_FOUND);
  }
  return members.map((s) => toCreateEntry(s, serverId));
}

export function selectDockerfileService(scan: RepoScanResponse, service?: string): DetectedService {
  const services = scan.services;
  const describe = (s: DetectedService): string => `${s.suggested_slug} (${s.base_directory})`;
  if (services.length === 0) {
    throw exitError(`nothing to deploy: no Dockerfile or compose file found at ${scan.ref}`, EXIT.NOT_FOUND);
  }
  if (service !== undefined) {
    const found = services.find(
      (s) =>
        s.name === service ||
        s.suggested_slug === service ||
        s.service_id === service ||
        s.base_directory === service,
    );
    if (found) return found;
    throw exitError(
      `service '${service}' not found at ${scan.ref}. found: ${services.map(describe).join(", ")}`,
      EXIT.MISUSE,
    );
  }
  const [only] = services;
  if (services.length === 1 && only !== undefined) return only;
  throw exitError(
    `several services found at ${scan.ref}; pass --service. found: ${services.map(describe).join(", ")}`,
    EXIT.MISUSE,
  );
}

export function wizardSetup(
  client: ApiClient,
  tid: string,
  body: WizardCreateRequest,
): Promise<WizardCreateResponse> {
  return client.post<WizardCreateResponse>(`/tenants/${tid}/wizard/setup`, body);
}

export interface CreateStackInput {
  repositoryId: string;
  repositoryName: string;
  serverId: string;
  composeFile?: string;
  branch?: string;
  name?: string;
}

export interface CreateStackResult {
  scan: RepoScanResponse;
  composeFile: string;
  groupId: string;
  response: WizardCreateResponse;
}

export async function createStack(
  client: ApiClient,
  tid: string,
  input: CreateStackInput,
  prescanned?: RepoScanResponse,
): Promise<CreateStackResult> {
  const scan =
    prescanned ?? (await scanRepository(client, tid, input.repositoryId, { ref: input.branch }));
  const composeFile = pickComposeFile(scan, input.composeFile);
  const services = stackServices(scan, composeFile, input.serverId);
  const response = await wizardSetup(client, tid, {
    repository_id: input.repositoryId,
    group_name: input.name ?? input.repositoryName,
    group_description: "",
    services,
    secret_project_bindings: [],
    deploy_as_stack: true,
    deploy_branch: scan.ref,
  });
  if (!response.group) {
    throw exitError("the API created no stack for this compose file", EXIT.GENERIC);
  }
  return { scan, composeFile, groupId: response.group.id, response };
}

export interface CreateAppInput {
  repositoryId: string;
  serverId: string;
  service: DetectedService;
  name?: string;
  branch?: string;
}

export interface CreateAppResult {
  appId: string;
  response: WizardCreateResponse;
}

export async function createApp(
  client: ApiClient,
  tid: string,
  input: CreateAppInput,
): Promise<CreateAppResult> {
  const entry = toCreateEntry(input.service, input.serverId);
  if (input.name !== undefined) {
    entry.name = input.name;
    delete entry.slug;
  }
  entry.deploy_branch = input.branch ?? null;
  const response = await wizardSetup(client, tid, {
    repository_id: input.repositoryId,
    group_name: null,
    group_description: "",
    services: [entry],
    secret_project_bindings: [],
    deploy_as_stack: false,
    deploy_branch: null,
  });
  const [created] = response.created;
  if (!created) {
    const why = response.skipped.map((s) => `${s.name}: ${s.reason}`).join("; ");
    throw exitError(`the API created no application${why ? ` (${why})` : ""}`, EXIT.GENERIC);
  }
  return { appId: created.id, response };
}

export interface LinkOptions {
  wait: boolean;
  waitTimeoutSeconds: number;
}

export interface LinkDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface LinkResult {
  repository: Repository | null;
  alreadyLinked: boolean;
  actions: string[];
}

const LINK_POLL_MS = 3000;

export async function linkRepository(
  client: ApiClient,
  tid: string,
  fullName: string,
  opts: LinkOptions,
  deps: LinkDeps = {},
): Promise<LinkResult> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const wanted = fullName.toLowerCase();
  const repoName = fullName.split("/")[1] ?? fullName;

  const find = async (): Promise<Repository | null> => {
    const repos = await listRepositories(client, tid, repoName);
    return repos.find((r) => r.full_name.toLowerCase() === wanted) ?? null;
  };

  const existing = await find();
  if (existing) return { repository: existing, alreadyLinked: true, actions: [] };

  const actions: string[] = [];
  const installations = await client.get<GitHubInstallation[]>(
    `/tenants/${tid}/github/installations`,
  );
  for (const inst of installations) {
    if (inst.status === "suspended") continue;
    const base = `/tenants/${tid}/github/installations/${inst.installation_id}`;
    let available: GitHubAvailableRepo[];
    try {
      available = await client.get<GitHubAvailableRepo[]>(`${base}/repos/available`);
    } catch (e) {
      if (e instanceof PermissionError || !(e instanceof ApiError)) throw e;
      log(`could not list repositories of GitHub account ${inst.account_login}: ${e.message}`);
      continue;
    }
    const match = available.find((r) => r.full_name.toLowerCase() === wanted);
    if (!match) continue;
    if (inst.repo_selection === "selected" && !inst.selected_repo_ids.includes(match.id)) {
      const ids = [...new Set([...inst.selected_repo_ids, match.id])];
      await client.put(`${base}/repos`, { repo_selection: "selected", selected_repo_ids: ids });
      actions.push(`added ${fullName} to the repositories mirrored from GitHub account ${inst.account_login}`);
    } else {
      await client.post(`${base}/sync`, {});
      actions.push(`queued a sync of GitHub account ${inst.account_login}`);
    }
    break;
  }

  if (actions.length === 0) {
    const providers = await client.get<GitProvider[]>(`/tenants/${tid}/git-providers`);
    for (const p of providers) {
      if (p.provider_type !== "gitea" || !p.is_connected) continue;
      await client.post(`/tenants/${tid}/git-providers/${p.id}/sync`, {});
      actions.push(`queued a sync of Gitea provider ${p.name}`);
    }
  }

  if (actions.length === 0) {
    throw exitError(
      `${fullName} is not visible to any connected provider. ` +
        "For GitHub, give the Reoclo GitHub App access to the repository in your GitHub installation settings, then run this command again. " +
        "For Gitea, connect the provider with 'reoclo providers connect <provider>'.",
      EXIT.NOT_FOUND,
    );
  }
  for (const line of actions) log(line);
  if (!opts.wait) return { repository: null, alreadyLinked: false, actions };

  const startedAt = now();
  for (;;) {
    const repo = await find();
    if (repo) return { repository: repo, alreadyLinked: false, actions };
    if (now() - startedAt >= opts.waitTimeoutSeconds * 1000) {
      throw exitError(
        `timed out after ${opts.waitTimeoutSeconds}s waiting for ${fullName} to appear in the repository list. ` +
          `The sync may still be running; check 'reoclo repos ls --search ${repoName}'.`,
        12,
      );
    }
    await sleep(LINK_POLL_MS);
  }
}
