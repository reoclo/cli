import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRepoFullName,
  printScan,
  runReposLink,
  runReposLs,
  runReposScan,
  scanServiceRows,
} from "../../../src/commands/repos";
import { Command } from "commander";
import { registerRepos } from "../../../src/commands/repos";
import { FakeApi, FakeClock, TID, captureOutput, repo, scan, service } from "../../helpers/fake-api";

const REPO = repo();
const SCAN_PATH = `/tenants/${TID}/repositories/${REPO.id}/scan-services`;
const REPOS_PATH = `/tenants/${TID}/repositories/`;
const GH_PATH = `/tenants/${TID}/github/installations`;

async function rejected(p: Promise<unknown>): Promise<Error & { exitCode?: number }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { exitCode?: number };
  }
  throw new Error("expected the promise to reject");
}

describe("repos command group", () => {
  test("registers scan and link next to ls, get and branches", () => {
    const program = new Command().name("reoclo");
    registerRepos(program);
    const group = program.commands.find((c) => c.name() === "repos")!;
    expect(group.commands.map((c) => c.name()).sort()).toEqual([
      "branches",
      "get",
      "link",
      "ls",
      "scan",
    ]);
  });
});

describe("repos ls --search", () => {
  test("sends the term as the q query parameter and lists the matches", async () => {
    const cache = mkdtempSync(join(tmpdir(), "reoclo-repos-ls-"));
    const previous = process.env.REOCLO_CACHE_DIR;
    process.env.REOCLO_CACHE_DIR = cache;
    try {
      const api = new FakeApi().on("GET", REPOS_PATH, { items: [REPO], total: 1, skip: 0, limit: 200 });
      const { out } = await captureOutput(() => runReposLs(api, TID, "web", "text"));
      const query = api.requests[0]?.query;
      expect(query?.get("q")).toBe("web");
      expect(query?.has("search")).toBe(false);
      expect(out).toMatch(/acme\/web\s+main/);
    } finally {
      if (previous === undefined) delete process.env.REOCLO_CACHE_DIR;
      else process.env.REOCLO_CACHE_DIR = previous;
      rmSync(cache, { recursive: true, force: true });
    }
  });
});

describe("repos scan", () => {
  const fixture = scan({
    services: [
      service(),
      service({
        name: "redis",
        compose_service: "redis",
        build_pack: "docker_image",
        image: "redis:7",
        container_port: null,
        source: "image",
      }),
    ],
    skipped_services: [{ name: "cache", reason: "no_build_context" }],
    deployment_configs: [
      { path: "reoclo.yml", label: "reoclo", valid: false, validation_error: "bad yaml" },
    ],
  });

  test("sends the ref and every --config path", async () => {
    const api = new FakeApi().on("POST", SCAN_PATH, fixture);
    await captureOutput(() =>
      runReposScan(api, TID, REPO.id, { ref: "feat/x", config: ["a.yml", "b.yml"] }, "text"),
    );
    expect(api.requests[0]?.body).toEqual({ ref: "feat/x", config_paths: ["a.yml", "b.yml"] });
  });

  test("sends a null ref when none is given", async () => {
    const api = new FakeApi().on("POST", SCAN_PATH, fixture);
    await captureOutput(() => runReposScan(api, TID, REPO.id, { config: [] }, "text"));
    expect(api.requests[0]?.body).toEqual({ ref: null, config_paths: [] });
  });

  test("more than five --config paths is refused without a request", async () => {
    const api = new FakeApi();
    const e = await rejected(
      runReposScan(api, TID, REPO.id, { config: ["1", "2", "3", "4", "5", "6"] }, "text"),
    );
    expect(e.exitCode).toBe(2);
    expect(e.message).toContain("at most 5");
    expect(api.requests).toEqual([]);
  });

  test("text output shows the scan summary and one row per service, skipped service and config", async () => {
    const { out } = await captureOutput(() => printScan(fixture, "text"));
    expect(out).toContain("main");
    expect(out).toContain("abcdef12");
    expect(out).toContain("docker-compose.yml");
    expect(out).toMatch(/NAME\s+SOURCE\s+BUILD PACK\s+COMPOSE FILE\s+SERVICE\s+PORT\s+IMAGE/);
    expect(out).toMatch(/web\s+compose\s+docker_compose\s+docker-compose\.yml\s+web\s+3000/);
    expect(out).toMatch(/redis\s+image\s+docker_image\s+docker-compose\.yml\s+redis\s+redis:7/);
    expect(out).toMatch(/SKIPPED\s+REASON/);
    expect(out).toMatch(/cache\s+no_build_context/);
    expect(out).toMatch(/reoclo\.yml\s+reoclo\s+bad yaml/);
  });

  test("text output says so when nothing is deployable", async () => {
    const { out } = await captureOutput(() =>
      printScan(scan({ compose_files: [], services: [] }), "text"),
    );
    expect(out).toContain("none");
    expect(out).toContain("No deployable services found.");
  });

  test("json output is the raw scan response", async () => {
    const api = new FakeApi().on("POST", SCAN_PATH, fixture);
    const { out } = await captureOutput(() =>
      runReposScan(api, TID, REPO.id, { config: [] }, "json"),
    );
    expect(JSON.parse(out)).toEqual(JSON.parse(JSON.stringify(fixture)));
  });

  test("scanServiceRows fills blanks for missing values", () => {
    const [row] = scanServiceRows(
      scan({ services: [service({ compose_file_path: null, compose_service: null, container_port: null })] }),
    );
    expect(row).toMatchObject({ compose_file: "", service: "", port: "", image: "" });
  });
});

describe("repos link", () => {
  test("parseRepoFullName accepts owner/name and repository URLs", () => {
    expect(parseRepoFullName("acme/web")).toBe("acme/web");
    expect(parseRepoFullName("acme/web.git")).toBe("acme/web");
    expect(parseRepoFullName("git@github.com:acme/web.git")).toBe("acme/web");
    expect(parseRepoFullName("https://github.com/acme/web")).toBe("acme/web");
    expect(() => parseRepoFullName("web")).toThrow("Use owner/name");
  });

  test("an already linked repository prints the confirmation and changes nothing", async () => {
    const api = new FakeApi().on("GET", REPOS_PATH, { items: [REPO], total: 1, skip: 0, limit: 200 });
    const { out } = await captureOutput(() =>
      runReposLink(api, TID, "acme/web", { wait: true, waitTimeoutSeconds: 180 }, "text"),
    );
    expect(out).toBe(`✓ acme/web is already linked (id: ${REPO.id})\n`);
    expect(api.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  test("--no-wait prints that the sync was queued, and json reports the actions", async () => {
    const make = (): FakeApi =>
      new FakeApi()
        .on("GET", REPOS_PATH, { items: [], total: 0, skip: 0, limit: 200 })
        .on("GET", GH_PATH, [
          { installation_id: 77, account_login: "acme", repo_selection: "all", selected_repo_ids: [] },
        ])
        .on("GET", `${GH_PATH}/77/repos/available`, [
          { id: 42, full_name: "acme/web", private: true, archived: false },
        ])
        .on("POST", `${GH_PATH}/77/sync`, {});
    const logged: string[] = [];
    const deps = { log: (l: string) => void logged.push(l), sleep: new FakeClock().sleep };
    const text = await captureOutput(() =>
      runReposLink(make(), TID, "acme/web", { wait: false, waitTimeoutSeconds: 180 }, "text", deps),
    );
    expect(text.out).toContain("sync queued for acme/web");
    expect(logged).toEqual(["queued a sync of GitHub account acme"]);
    const json = await captureOutput(() =>
      runReposLink(make(), TID, "acme/web", { wait: false, waitTimeoutSeconds: 180 }, "json", deps),
    );
    expect(JSON.parse(json.out)).toEqual({
      full_name: "acme/web",
      status: "syncing",
      actions: ["queued a sync of GitHub account acme"],
    });
  });

  test("a repository that appears while waiting is printed as an object in json", async () => {
    let lists = 0;
    const api = new FakeApi()
      .on("GET", REPOS_PATH, () => {
        lists += 1;
        return { items: lists > 1 ? [REPO] : [], total: 0, skip: 0, limit: 200 };
      })
      .on("GET", GH_PATH, [
        { installation_id: 77, account_login: "acme", repo_selection: "all", selected_repo_ids: [] },
      ])
      .on("GET", `${GH_PATH}/77/repos/available`, [
        { id: 42, full_name: "acme/web", private: true, archived: false },
      ])
      .on("POST", `${GH_PATH}/77/sync`, {});
    const clock = new FakeClock();
    const { out } = await captureOutput(() =>
      runReposLink(api, TID, "acme/web", { wait: true, waitTimeoutSeconds: 180 }, "json", {
        log: () => undefined,
        sleep: clock.sleep,
        now: clock.now,
      }),
    );
    expect((JSON.parse(out) as { id: string }).id).toBe(REPO.id);
  });
});
