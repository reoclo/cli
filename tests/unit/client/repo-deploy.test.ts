import { describe, expect, test } from "bun:test";
import {
  createApp,
  createStack,
  linkRepository,
  listRepositories,
  pickComposeFile,
  scanRepository,
  selectDockerfileService,
  stackServices,
} from "../../../src/client/repo-deploy";
import type { WizardCreateResponse, WizardCreateRequest } from "../../../src/client/types";
import { FakeApi, FakeClock, SERVER_ID, TID, repo, scan, service } from "../../helpers/fake-api";

const REPO = repo();
const REPOS_PATH = `/tenants/${TID}/repositories/`;
const SCAN_PATH = `/tenants/${TID}/repositories/${REPO.id}/scan-services`;
const WIZARD_PATH = `/tenants/${TID}/wizard/setup`;
const GH_PATH = `/tenants/${TID}/github/installations`;
const PROVIDERS_PATH = `/tenants/${TID}/git-providers`;

function thrown(fn: () => unknown): Error & { exitCode?: number } {
  try {
    fn();
  } catch (e) {
    return e as Error & { exitCode?: number };
  }
  throw new Error("expected the call to throw");
}

async function rejected(p: Promise<unknown>): Promise<Error & { exitCode?: number }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { exitCode?: number };
  }
  throw new Error("expected the promise to reject");
}

describe("listRepositories", () => {
  test("sends the search term as q, never as search", async () => {
    const api = new FakeApi().on("GET", REPOS_PATH, { items: [REPO], total: 1, skip: 0, limit: 200 });
    await listRepositories(api, TID, "we b");
    const query = api.requests[0]?.query;
    expect(query?.get("q")).toBe("we b");
    expect(query?.has("search")).toBe(false);
    expect(query?.get("skip")).toBe("0");
    expect(query?.get("limit")).toBe("200");
  });

  test("sends no filter without a term and pages until a short page", async () => {
    const full = Array.from({ length: 200 }, (_, i) => repo({ id: `r-${i}`, full_name: `acme/r${i}` }));
    const api = new FakeApi().on("GET", REPOS_PATH, (req) =>
      req.query.get("skip") === "0" ? { items: full } : { items: [REPO] },
    );
    const all = await listRepositories(api, TID);
    expect(all).toHaveLength(201);
    expect(api.requests.map((r) => r.query.get("skip"))).toEqual(["0", "200"]);
    expect(api.requests.every((r) => !r.query.has("q"))).toBe(true);
  });
});

describe("scanRepository", () => {
  test("posts ref and config paths, null ref by default", async () => {
    const api = new FakeApi().on("POST", SCAN_PATH, scan());
    await scanRepository(api, TID, REPO.id);
    await scanRepository(api, TID, REPO.id, { ref: "feat/x", configPaths: ["a.yml", "b.yml"] });
    expect(api.requests.map((r) => r.body)).toEqual([
      { ref: null, config_paths: [] },
      { ref: "feat/x", config_paths: ["a.yml", "b.yml"] },
    ]);
  });
});

describe("pickComposeFile", () => {
  test("uses the only compose file", () => {
    expect(pickComposeFile(scan())).toBe("docker-compose.yml");
  });

  test("uses the flag, with or without a leading ./", () => {
    const s = scan({ compose_files: ["docker-compose.yml", "deploy/prod.yml"] });
    expect(pickComposeFile(s, "deploy/prod.yml")).toBe("deploy/prod.yml");
    expect(pickComposeFile(s, "./deploy/prod.yml")).toBe("deploy/prod.yml");
  });

  test("fails and lists the files when there are several and no flag", () => {
    const s = scan({ compose_files: ["docker-compose.yml", "deploy/prod.yml"] });
    const e = thrown(() => pickComposeFile(s));
    expect(e.exitCode).toBe(2);
    expect(e.message).toContain("docker-compose.yml, deploy/prod.yml");
    expect(e.message).toContain("--compose-file");
  });

  test("fails when the flag names a file the scan did not find", () => {
    const e = thrown(() => pickComposeFile(scan(), "nope.yml"));
    expect(e.exitCode).toBe(2);
    expect(e.message).toContain("found: docker-compose.yml");
  });

  test("fails when the repository has no compose file", () => {
    const e = thrown(() => pickComposeFile(scan({ compose_files: [] })));
    expect(e.exitCode).toBe(5);
  });
});

describe("stackServices", () => {
  const built = service({
    name: "api",
    suggested_slug: "api",
    base_directory: "api",
    compose_service: "api",
    build_pack: "docker_compose",
    container_port: 4000,
  });
  const imageService = service({
    name: "redis",
    suggested_slug: "redis",
    compose_service: "redis",
    build_pack: "docker_image",
    image: "redis:7",
    container_port: null,
    ports: [],
    source: "image",
  });
  const otherFile = service({
    name: "other",
    compose_file_path: "deploy/prod.yml",
    compose_service: "other",
  });

  test("builds one create entry per service of the chosen compose file", () => {
    const entries = stackServices(
      scan({ services: [built, imageService, otherFile] }),
      "docker-compose.yml",
      SERVER_ID,
    );
    expect(entries).toEqual([
      {
        action: "create",
        name: "api",
        slug: "api",
        server_id: SERVER_ID,
        base_directory: "api",
        build_pack: "docker_compose",
        compose_file_path: "docker-compose.yml",
        compose_service: "api",
        container_port: 4000,
        deploy_branch: null,
        auto_deploy: true,
        linked_container_name: null,
        docker_image: null,
      },
      {
        action: "create",
        name: "redis",
        slug: "redis",
        server_id: SERVER_ID,
        base_directory: ".",
        build_pack: "docker_image",
        compose_file_path: "docker-compose.yml",
        compose_service: "redis",
        container_port: 8080,
        deploy_branch: null,
        auto_deploy: true,
        linked_container_name: null,
        docker_image: "redis:7",
      },
    ]);
  });

  test("an image service without a compose service keeps the detected build pack", () => {
    const loose = service({
      compose_service: null,
      build_pack: "docker_image",
      image: "redis:7",
    });
    const [entry] = stackServices(
      scan({ services: [built, { ...loose, compose_service: "x" }] }),
      "docker-compose.yml",
      SERVER_ID,
    );
    expect(entry?.docker_image).toBeNull();
  });

  test("fails when the compose file has no services", () => {
    const e = thrown(() => stackServices(scan({ services: [otherFile] }), "docker-compose.yml", SERVER_ID));
    expect(e.exitCode).toBe(5);
  });
});

describe("selectDockerfileService", () => {
  const web = service({ name: "web", suggested_slug: "web", base_directory: "web", compose_service: null, source: "dockerfile", build_pack: "dockerfile" });
  const api = service({ name: "api", suggested_slug: "api", base_directory: "api", compose_service: null, source: "dockerfile", build_pack: "dockerfile" });

  test("picks the only service, or the one --service names", () => {
    expect(selectDockerfileService(scan({ services: [web] }))).toBe(web);
    expect(selectDockerfileService(scan({ services: [web, api] }), "api")).toBe(api);
  });

  test("fails with the list when there are several and none is named", () => {
    const e = thrown(() => selectDockerfileService(scan({ services: [web, api] })));
    expect(e.exitCode).toBe(2);
    expect(e.message).toContain("web (web), api (api)");
  });

  test("fails when --service matches nothing or nothing was found", () => {
    expect(thrown(() => selectDockerfileService(scan({ services: [web] }), "nope")).exitCode).toBe(2);
    expect(thrown(() => selectDockerfileService(scan({ services: [] }))).exitCode).toBe(5);
  });
});

const WIZARD_OK: WizardCreateResponse = {
  group: { id: "g-1", name: "web", slug: "web", kind: "compose" },
  created: [{ id: "a-1", name: "web", slug: "web", status: "pending" }],
  adopted: [],
  skipped: [],
};

describe("createStack", () => {
  test("sends deploy_as_stack, the scanned branch and the repository name as group name", async () => {
    const api = new FakeApi().on("POST", SCAN_PATH, scan({ ref: "main" })).on("POST", WIZARD_PATH, WIZARD_OK);
    const result = await createStack(api, TID, {
      repositoryId: REPO.id,
      repositoryName: "web",
      serverId: SERVER_ID,
    });
    expect(result.groupId).toBe("g-1");
    const body = api.calls("POST", WIZARD_PATH)[0]?.body as WizardCreateRequest;
    expect(body.deploy_as_stack).toBe(true);
    expect(body.deploy_branch).toBe("main");
    expect(body.group_name).toBe("web");
    expect(body.repository_id).toBe(REPO.id);
    expect(body.services).toHaveLength(1);
    expect(api.calls("POST", SCAN_PATH)[0]?.body).toEqual({ ref: null, config_paths: [] });
  });

  test("scans the requested branch and names the stack from --name", async () => {
    const api = new FakeApi()
      .on("POST", SCAN_PATH, scan({ ref: "staging" }))
      .on("POST", WIZARD_PATH, WIZARD_OK);
    await createStack(api, TID, {
      repositoryId: REPO.id,
      repositoryName: "web",
      serverId: SERVER_ID,
      branch: "staging",
      name: "web-staging",
    });
    expect(api.calls("POST", SCAN_PATH)[0]?.body).toEqual({ ref: "staging", config_paths: [] });
    const body = api.calls("POST", WIZARD_PATH)[0]?.body as WizardCreateRequest;
    expect(body.deploy_branch).toBe("staging");
    expect(body.group_name).toBe("web-staging");
  });

  test("fails before the wizard call when several compose files are found", async () => {
    const api = new FakeApi().on(
      "POST",
      SCAN_PATH,
      scan({ compose_files: ["a.yml", "b.yml"] }),
    );
    const e = await rejected(
      createStack(api, TID, { repositoryId: REPO.id, repositoryName: "web", serverId: SERVER_ID }),
    );
    expect(e.exitCode).toBe(2);
    expect(api.calls("POST", WIZARD_PATH)).toHaveLength(0);
  });

  test("surfaces the API's refusal as thrown", async () => {
    const api = new FakeApi().on("POST", SCAN_PATH, scan()).on("POST", WIZARD_PATH, () => {
      throw new Error("stack services must share one server");
    });
    const e = await rejected(
      createStack(api, TID, { repositoryId: REPO.id, repositoryName: "web", serverId: SERVER_ID }),
    );
    expect(e.message).toBe("stack services must share one server");
  });
});

describe("createApp", () => {
  const dockerfile = service({
    name: "web",
    suggested_slug: "web-svc",
    compose_file_path: null,
    compose_service: null,
    build_pack: "dockerfile",
    dockerfile_path: "Dockerfile",
    source: "dockerfile",
    container_port: null,
  });

  test("posts one entry without a stack and returns the created app", async () => {
    const api = new FakeApi().on("POST", WIZARD_PATH, { ...WIZARD_OK, group: null });
    const result = await createApp(api, TID, {
      repositoryId: REPO.id,
      serverId: SERVER_ID,
      service: dockerfile,
      branch: "main",
    });
    expect(result.appId).toBe("a-1");
    const body = api.calls("POST", WIZARD_PATH)[0]?.body as WizardCreateRequest;
    expect(body.deploy_as_stack).toBe(false);
    expect(body.group_name).toBeNull();
    expect(body.services[0]).toMatchObject({
      slug: "web-svc",
      build_pack: "dockerfile",
      dockerfile_path: "Dockerfile",
      container_port: 8080,
      deploy_branch: "main",
    });
  });

  test("--name replaces the slug", async () => {
    const api = new FakeApi().on("POST", WIZARD_PATH, WIZARD_OK);
    await createApp(api, TID, {
      repositoryId: REPO.id,
      serverId: SERVER_ID,
      service: dockerfile,
      name: "Marketing",
    });
    const entry = (api.calls("POST", WIZARD_PATH)[0]?.body as WizardCreateRequest).services[0];
    expect(entry?.name).toBe("Marketing");
    expect(entry?.slug).toBeUndefined();
  });

  test("fails with the skip reasons when nothing was created", async () => {
    const api = new FakeApi().on("POST", WIZARD_PATH, {
      group: null,
      created: [],
      adopted: [],
      skipped: [{ name: "web", reason: "name_taken" }],
    });
    const e = await rejected(
      createApp(api, TID, { repositoryId: REPO.id, serverId: SERVER_ID, service: dockerfile }),
    );
    expect(e.message).toContain("web: name_taken");
  });
});

describe("linkRepository", () => {
  const clock = (): FakeClock => new FakeClock();
  const OPTS = { wait: true, waitTimeoutSeconds: 180 };

  function repoList(api: FakeApi, appearsAfterLists: number): { count: () => number } {
    let lists = 0;
    api.on("GET", REPOS_PATH, () => {
      lists += 1;
      return { items: lists > appearsAfterLists ? [REPO] : [], total: 0, skip: 0, limit: 200 };
    });
    return { count: () => lists };
  }

  test("returns at once when the repository is already linked", async () => {
    const api = new FakeApi();
    repoList(api, 0);
    const result = await linkRepository(api, TID, "ACME/Web", OPTS, clock());
    expect(result.alreadyLinked).toBe(true);
    expect(result.repository?.full_name).toBe("acme/web");
    expect(api.requests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(api.requests.some((r) => r.path.includes("github"))).toBe(false);
    expect(api.requests[0]?.query.get("q")).toBe("Web");
  });

  test("GitHub selected mode keeps the existing ids and adds the new one", async () => {
    const api = new FakeApi().on("GET", GH_PATH, [
      {
        installation_id: 77,
        account_login: "acme",
        status: "active",
        repo_selection: "selected",
        selected_repo_ids: [5, 9],
      },
    ]);
    api.on("GET", `${GH_PATH}/77/repos/available`, [
      { id: 9, full_name: "acme/old", private: false, archived: false },
      { id: 42, full_name: "acme/web", private: true, archived: false },
    ]);
    api.on("PUT", `${GH_PATH}/77/repos`, {});
    repoList(api, 1);
    const result = await linkRepository(api, TID, "acme/web", OPTS, clock());
    expect(api.calls("PUT", `${GH_PATH}/77/repos`)[0]?.body).toEqual({
      repo_selection: "selected",
      selected_repo_ids: [5, 9, 42],
    });
    expect(result.alreadyLinked).toBe(false);
    expect(result.repository?.id).toBe(REPO.id);
    expect(api.calls("POST", `${GH_PATH}/77/sync`)).toHaveLength(0);
  });

  test("GitHub all mode queues an installation sync and does not write the selection", async () => {
    const api = new FakeApi().on("GET", GH_PATH, [
      { installation_id: 77, account_login: "acme", repo_selection: "all", selected_repo_ids: [] },
    ]);
    api.on("GET", `${GH_PATH}/77/repos/available`, [
      { id: 42, full_name: "acme/web", private: true, archived: false },
    ]);
    api.on("POST", `${GH_PATH}/77/sync`, { status: "queued" });
    repoList(api, 1);
    await linkRepository(api, TID, "acme/web", OPTS, clock());
    expect(api.calls("POST", `${GH_PATH}/77/sync`)).toHaveLength(1);
    expect(api.calls("PUT", `${GH_PATH}/77/repos`)).toHaveLength(0);
  });

  test("a repository already in the selection only needs a sync", async () => {
    const api = new FakeApi().on("GET", GH_PATH, [
      {
        installation_id: 77,
        account_login: "acme",
        repo_selection: "selected",
        selected_repo_ids: [42],
      },
    ]);
    api.on("GET", `${GH_PATH}/77/repos/available`, [
      { id: 42, full_name: "acme/web", private: true, archived: false },
    ]);
    api.on("POST", `${GH_PATH}/77/sync`, {});
    repoList(api, 1);
    await linkRepository(api, TID, "acme/web", OPTS, clock());
    expect(api.calls("PUT", `${GH_PATH}/77/repos`)).toHaveLength(0);
    expect(api.calls("POST", `${GH_PATH}/77/sync`)).toHaveLength(1);
  });

  test("a suspended installation is skipped and a Gitea provider is synced", async () => {
    const api = new FakeApi().on("GET", GH_PATH, [
      { installation_id: 77, account_login: "acme", status: "suspended", repo_selection: "all", selected_repo_ids: [] },
    ]);
    api.on("GET", PROVIDERS_PATH, [
      { id: "p-gh", provider_type: "github", is_connected: true, name: "GitHub" },
      { id: "p-off", provider_type: "gitea", is_connected: false, name: "Offline" },
      { id: "p-1", provider_type: "gitea", is_connected: true, name: "Forge" },
    ]);
    api.on("POST", `${PROVIDERS_PATH}/p-1/sync`, { status: "queued" });
    repoList(api, 1);
    const result = await linkRepository(api, TID, "acme/web", OPTS, clock());
    expect(api.calls("POST", `${PROVIDERS_PATH}/p-1/sync`)).toHaveLength(1);
    expect(api.requests.some((r) => r.path.includes("/p-gh/") || r.path.includes("/p-off/"))).toBe(false);
    expect(result.actions).toEqual(["queued a sync of Gitea provider Forge"]);
  });

  test("fails with guidance when no provider can see the repository", async () => {
    const api = new FakeApi().on("GET", GH_PATH, [
      { installation_id: 77, account_login: "acme", repo_selection: "selected", selected_repo_ids: [] },
    ]);
    api.on("GET", `${GH_PATH}/77/repos/available`, [
      { id: 9, full_name: "acme/other", private: false, archived: false },
    ]);
    api.on("GET", PROVIDERS_PATH, []);
    repoList(api, 99);
    const e = await rejected(linkRepository(api, TID, "acme/web", OPTS, clock()));
    expect(e.exitCode).toBe(5);
    expect(e.message).toContain("acme/web is not visible to any connected provider");
    expect(e.message).toContain("GitHub App");
    expect(e.message).toContain("reoclo providers connect");
    expect(api.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  test("waits until the repository appears, polling on the injected sleep", async () => {
    const api = new FakeApi().on("GET", GH_PATH, [
      { installation_id: 77, account_login: "acme", repo_selection: "all", selected_repo_ids: [] },
    ]);
    api.on("GET", `${GH_PATH}/77/repos/available`, [
      { id: 42, full_name: "acme/web", private: true, archived: false },
    ]);
    api.on("POST", `${GH_PATH}/77/sync`, {});
    const lists = repoList(api, 3);
    const c = clock();
    const result = await linkRepository(api, TID, "acme/web", OPTS, c);
    expect(result.repository?.id).toBe(REPO.id);
    expect(lists.count()).toBe(4);
    expect(c.slept).toEqual([3000, 3000]);
  });

  test("times out with exit code 12 when the repository never appears", async () => {
    const api = new FakeApi().on("GET", GH_PATH, [
      { installation_id: 77, account_login: "acme", repo_selection: "all", selected_repo_ids: [] },
    ]);
    api.on("GET", `${GH_PATH}/77/repos/available`, [
      { id: 42, full_name: "acme/web", private: true, archived: false },
    ]);
    api.on("POST", `${GH_PATH}/77/sync`, {});
    repoList(api, 999);
    const c = clock();
    const e = await rejected(
      linkRepository(api, TID, "acme/web", { wait: true, waitTimeoutSeconds: 10 }, c),
    );
    expect(e.exitCode).toBe(12);
    expect(e.message).toContain("timed out after 10s");
    expect(c.time).toBeGreaterThanOrEqual(10_000);
  });

  test("--no-wait returns the queued actions without polling", async () => {
    const api = new FakeApi().on("GET", GH_PATH, [
      { installation_id: 77, account_login: "acme", repo_selection: "all", selected_repo_ids: [] },
    ]);
    api.on("GET", `${GH_PATH}/77/repos/available`, [
      { id: 42, full_name: "acme/web", private: true, archived: false },
    ]);
    api.on("POST", `${GH_PATH}/77/sync`, {});
    const lists = repoList(api, 999);
    const c = clock();
    const result = await linkRepository(api, TID, "acme/web", { wait: false, waitTimeoutSeconds: 180 }, c);
    expect(result.repository).toBeNull();
    expect(result.actions).toHaveLength(1);
    expect(lists.count()).toBe(1);
    expect(c.slept).toEqual([]);
  });
});
