import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { findRepository, registerUp, runUp, type UpDeps, type UpFlags } from "../../../src/commands/up";
import { getRequiredCapability } from "../../../src/client/command-meta";
import type { WizardCreateRequest } from "../../../src/client/types";
import {
  FakeApi,
  FakeClock,
  SERVER_ID,
  TID,
  collectIo,
  repo,
  scan,
  service,
  type CollectedIo,
} from "../../helpers/fake-api";

const REPO = repo();
const REPOS_PATH = `/tenants/${TID}/repositories/`;
const GROUPS_PATH = `/tenants/${TID}/application-groups/`;
const APPS_PATH = `/tenants/${TID}/applications/`;
const SCAN_PATH = `/tenants/${TID}/repositories/${REPO.id}/scan-services`;
const WIZARD_PATH = `/tenants/${TID}/wizard/setup`;
const STACK_DEPLOY = `/tenants/${TID}/application-groups/g-1/deploy`;
const STACK_RUN = `/tenants/${TID}/application-groups/g-1/deployments/gd-1`;
const APP_DEPLOY = `/tenants/${TID}/applications/a-1/deploy`;
const APP_RUN = `/tenants/${TID}/applications/a-1/deployments/d-1`;

const STACK = {
  id: "g-1",
  slug: "web",
  name: "web",
  kind: "compose",
  repository_id: REPO.id,
  compose_file_path: "docker-compose.yml",
  deploy_branch: "main",
};
const APP = { id: "a-1", slug: "web", name: "Web", repository_id: REPO.id, group_id: null };

interface World {
  groups?: unknown[];
  apps?: unknown[];
  scanResponse?: ReturnType<typeof scan>;
  stackStatus?: string;
  appStatus?: string;
}

function world(w: World = {}): FakeApi {
  return new FakeApi()
    .on("GET", REPOS_PATH, { items: [REPO], total: 1, skip: 0, limit: 200 })
    .on("GET", GROUPS_PATH, w.groups ?? [])
    .on("GET", APPS_PATH, { items: w.apps ?? [], total: 0, skip: 0, limit: 200 })
    .on("POST", SCAN_PATH, w.scanResponse ?? scan())
    .on("POST", WIZARD_PATH, (req) =>
      (req.body as WizardCreateRequest).deploy_as_stack
        ? {
            group: { id: "g-1", name: "web", slug: "web", kind: "compose" },
            created: [{ id: "a-2", name: "web", slug: "web", status: "pending" }],
            adopted: [],
            skipped: [],
          }
        : {
            group: null,
            created: [{ id: "a-1", name: "web", slug: "web", status: "pending" }],
            adopted: [],
            skipped: [],
          },
    )
    .on("POST", STACK_DEPLOY, { total: 1, triggered: 1, skipped: 0, group_deployment_id: "gd-1" })
    .on("GET", STACK_RUN, {
      id: "gd-1",
      deployment_number: 3,
      status: w.stackStatus ?? "succeeded",
      error_message: "stack failed",
    })
    .on("POST", APP_DEPLOY, { id: "d-1", status: "queued" })
    .on("GET", APP_RUN, { status: w.appStatus ?? "succeeded" });
}

function flags(over: Partial<UpFlags> = {}): UpFlags {
  return { wait: true, waitTimeout: "600", ...over };
}

interface Harness {
  deps: UpDeps;
  out: CollectedIo;
  clock: FakeClock;
  logged: string[];
}

function harness(remote: string | null = "git@github.com:acme/web.git"): Harness {
  const out = collectIo();
  const clock = new FakeClock();
  const logged: string[] = [];
  return {
    out,
    clock,
    logged,
    deps: {
      io: out.io,
      sleep: clock.sleep,
      now: clock.now,
      log: (l) => void logged.push(l),
      readOriginRemote: () => remote,
      resolveServerId: (ref) =>
        ref === "srv"
          ? Promise.resolve(SERVER_ID)
          : Promise.reject(new Error(`server '${ref}' not found`)),
    },
  };
}

async function rejected(p: Promise<unknown>): Promise<Error & { exitCode?: number }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { exitCode?: number };
  }
  throw new Error("expected the promise to reject");
}

const posts = (api: FakeApi): string[] =>
  api.requests.filter((r) => r.method === "POST").map((r) => r.path);

describe("registration", () => {
  test("up is a top-level command gated on app:deploy with --no-wait defaulting to wait", () => {
    const program = new Command().name("reoclo");
    registerUp(program);
    const up = program.commands.find((c) => c.name() === "up")!;
    expect(getRequiredCapability(up)).toBe("app:deploy");
    expect(up.options.map((o) => o.long).sort()).toEqual([
      "--branch",
      "--compose-file",
      "--force-recreate",
      "--name",
      "--no-wait",
      "--repo",
      "--server",
      "--service",
      "--wait-timeout",
    ]);
  });
});

describe("finding the repository", () => {
  test("reads the origin remote (ssh and https) and matches full_name case-insensitively", async () => {
    for (const remote of [
      "git@github.com:ACME/Web.git",
      "https://github.com/acme/web",
      "ssh://git@github.com/acme/web.git",
    ]) {
      const found = await findRepository(world(), TID, undefined, () => remote);
      expect(found.id).toBe(REPO.id);
    }
  });

  test("a repository that is not linked fails with the link command to run", async () => {
    const h = harness("https://github.com/acme/other.git");
    const api = world();
    const e = await rejected(runUp(api, TID, flags(), "text", h.deps));
    expect(e.exitCode).toBe(5);
    expect(e.message).toContain("'acme/other' is not linked to Reoclo");
    expect(e.message).toContain("reoclo repos link acme/other");
    expect(posts(api)).toEqual([]);
  });

  test("no origin remote asks for --repo", async () => {
    const e = await rejected(runUp(world(), TID, flags(), "text", harness(null).deps));
    expect(e.exitCode).toBe(2);
    expect(e.message).toContain("--repo");
  });

  test("an origin remote that names no repository asks for --repo", async () => {
    const e = await rejected(runUp(world(), TID, flags(), "text", harness("/srv/git/web").deps));
    expect(e.exitCode).toBe(2);
    expect(e.message).toContain("cannot read a repository name");
  });

  test("--repo accepts owner/name, an id and a unique short name, and ignores the remote", async () => {
    for (const ref of ["acme/web", "ACME/WEB", REPO.id, "web"]) {
      const found = await findRepository(world(), TID, ref, () => null);
      expect(found.id).toBe(REPO.id);
    }
    const e = await rejected(findRepository(world(), TID, "acme/nope", () => null));
    expect(e.exitCode).toBe(5);
  });
});

describe("an existing target", () => {
  test("an existing compose stack for the repository is deployed and waited for", async () => {
    const h = harness();
    const api = world({ groups: [STACK] });
    await runUp(api, TID, flags(), "text", h.deps);
    expect(posts(api)).toEqual([STACK_DEPLOY]);
    expect(h.out.lines[0]).toBe("deploying existing stack web");
    expect(h.out.lines.at(-1)).toBe("deployment #3: succeeded");
    expect(api.calls("POST", STACK_DEPLOY)[0]?.body).toBeUndefined();
  });

  test("--force-recreate reaches the stack deploy", async () => {
    const h = harness();
    const api = world({ groups: [STACK] });
    await runUp(api, TID, flags({ forceRecreate: true }), "text", h.deps);
    expect(api.calls("POST", STACK_DEPLOY)[0]?.body).toEqual({ force_recreate: true });
  });

  test("a stack of another repository or a manual group is not a match", async () => {
    const h = harness();
    const api = world({
      groups: [
        { ...STACK, id: "g-9", slug: "other", repository_id: "someone-else" },
        { ...STACK, id: "g-8", slug: "manual", kind: "manual" },
      ],
      apps: [APP],
    });
    await runUp(api, TID, flags(), "text", h.deps);
    expect(posts(api)).toEqual([APP_DEPLOY]);
  });

  test("an existing standalone application is deployed with --branch as the ref", async () => {
    const h = harness();
    const api = world({ apps: [APP] });
    await runUp(api, TID, flags({ branch: "feat/x" }), "text", h.deps);
    expect(posts(api)).toEqual([APP_DEPLOY]);
    expect(api.calls("POST", APP_DEPLOY)[0]?.body).toEqual({ ref: "feat/x" });
    expect(h.out.lines[0]).toBe("deploying existing application web");
    expect(h.out.raws.at(-1)).toBe("\n✓ succeeded\n");
  });

  test("a member app of a group is not a standalone match", async () => {
    const h = harness();
    const api = world({ apps: [{ ...APP, group_id: "g-1" }] });
    const e = await rejected(runUp(api, TID, flags(), "text", h.deps));
    expect(e.message).toContain("--server");
    expect(posts(api)).toEqual([]);
  });

  test("several stacks fail and list them; --compose-file picks one", async () => {
    const stacks = [
      STACK,
      { ...STACK, id: "g-2", slug: "web-prod", compose_file_path: "deploy/prod.yml" },
    ];
    const h = harness();
    const api = world({ groups: stacks });
    const e = await rejected(runUp(api, TID, flags(), "text", h.deps));
    expect(e.exitCode).toBe(2);
    expect(e.message).toContain("web (docker-compose.yml), web-prod (deploy/prod.yml)");
    expect(e.message).toContain("--compose-file");
    expect(posts(api)).toEqual([]);

    const ok = world({ groups: stacks });
    ok.on("POST", `/tenants/${TID}/application-groups/g-2/deploy`, {
      total: 1,
      triggered: 1,
      skipped: 0,
    });
    await runUp(ok, TID, flags({ composeFile: "./deploy/prod.yml" }), "text", harness().deps);
    expect(posts(ok)).toEqual([`/tenants/${TID}/application-groups/g-2/deploy`]);
  });

  test("several applications fail and list them; --service picks one", async () => {
    const apps = [APP, { ...APP, id: "a-3", slug: "api", name: "API" }];
    const api = world({ apps });
    const e = await rejected(runUp(api, TID, flags(), "text", harness().deps));
    expect(e.exitCode).toBe(2);
    expect(e.message).toContain("web, api");
    expect(e.message).toContain("--service");

    const ok = world({ apps, groups: [STACK] });
    ok.on("POST", `/tenants/${TID}/applications/a-3/deploy`, { id: "d-3", status: "queued" });
    await runUp(ok, TID, flags({ service: "api", wait: false }), "text", harness().deps);
    expect(posts(ok)).toEqual([`/tenants/${TID}/applications/a-3/deploy`]);
    expect(ok.calls("GET", GROUPS_PATH)).toHaveLength(0);
  });

  test("a --branch that differs from a stack's deploy branch is noted, not sent", async () => {
    const h = harness();
    const api = world({ groups: [STACK] });
    await runUp(api, TID, flags({ branch: "staging" }), "text", h.deps);
    expect(h.logged).toEqual([
      "note: --branch only applies when a stack is created; web deploys main",
    ]);
    expect(api.calls("POST", STACK_DEPLOY)[0]?.body).toBeUndefined();
  });
});

describe("the first run", () => {
  test("creates a stack from the compose file, deploys it and waits", async () => {
    const h = harness();
    const api = world();
    await runUp(api, TID, flags({ server: "srv" }), "text", h.deps);
    expect(posts(api)).toEqual([SCAN_PATH, WIZARD_PATH, STACK_DEPLOY]);
    const body = api.calls("POST", WIZARD_PATH)[0]?.body as WizardCreateRequest;
    expect(body.deploy_as_stack).toBe(true);
    expect(body.deploy_branch).toBe("main");
    expect(body.group_name).toBe("web");
    expect(body.services[0]?.server_id).toBe(SERVER_ID);
    expect(h.out.lines[0]).toContain("created stack web");
    expect(h.out.lines.at(-1)).toBe("deployment #3: succeeded");
  });

  test("creates an application when the repository has one Dockerfile and no compose file", async () => {
    const dockerfile = service({
      name: "web",
      suggested_slug: "web",
      compose_file_path: null,
      compose_service: null,
      build_pack: "dockerfile",
      dockerfile_path: "Dockerfile",
      source: "dockerfile",
      container_port: null,
    });
    const h = harness();
    const api = world({ scanResponse: scan({ compose_files: [], services: [dockerfile] }) });
    await runUp(api, TID, flags({ server: "srv", branch: "main", name: "Marketing" }), "text", h.deps);
    expect(posts(api)).toEqual([SCAN_PATH, WIZARD_PATH, APP_DEPLOY]);
    const body = api.calls("POST", WIZARD_PATH)[0]?.body as WizardCreateRequest;
    expect(body.deploy_as_stack).toBe(false);
    expect(body.services[0]).toMatchObject({ name: "Marketing", build_pack: "dockerfile", deploy_branch: "main" });
    expect(api.calls("POST", SCAN_PATH)[0]?.body).toEqual({ ref: "main", config_paths: [] });
    expect(api.calls("POST", APP_DEPLOY)[0]?.body).toEqual({});
    expect(h.out.lines[0]).toBe("✓ created application web (id: a-1)");
  });

  test("several Dockerfile services need --service", async () => {
    const mk = (name: string) =>
      service({
        name,
        suggested_slug: name,
        base_directory: name,
        compose_file_path: null,
        compose_service: null,
        build_pack: "dockerfile",
        source: "dockerfile",
      });
    const sc = scan({ compose_files: [], services: [mk("web"), mk("api")] });
    const e = await rejected(runUp(world({ scanResponse: sc }), TID, flags({ server: "srv" }), "text", harness().deps));
    expect(e.exitCode).toBe(2);
    expect(e.message).toContain("--service");

    const api = world({ scanResponse: sc });
    await runUp(api, TID, flags({ server: "srv", service: "api", wait: false }), "text", harness().deps);
    const body = api.calls("POST", WIZARD_PATH)[0]?.body as WizardCreateRequest;
    expect(body.services[0]?.slug).toBe("api");
  });

  test("without --server it fails before scanning anything", async () => {
    const api = world();
    const e = await rejected(runUp(api, TID, flags(), "text", harness().deps));
    expect(e.exitCode).toBe(2);
    expect(e.message).toContain("acme/web has no stack or application yet");
    expect(e.message).toContain("--server");
    expect(posts(api)).toEqual([]);
  });

  test("a repository with nothing to deploy fails", async () => {
    const api = world({ scanResponse: scan({ compose_files: [], services: [] }) });
    const e = await rejected(runUp(api, TID, flags({ server: "srv" }), "text", harness().deps));
    expect(e.exitCode).toBe(5);
    expect(posts(api)).toEqual([SCAN_PATH]);
  });

  test("an unknown --server stops before the scan", async () => {
    const api = world();
    const e = await rejected(runUp(api, TID, flags({ server: "nope" }), "text", harness().deps));
    expect(e.message).toBe("server 'nope' not found");
    expect(posts(api)).toEqual([]);
  });
});

describe("waiting and exit codes", () => {
  test("--no-wait returns right after the stack deploy is triggered", async () => {
    const h = harness();
    const api = world({ groups: [STACK] });
    await runUp(api, TID, flags({ wait: false }), "text", h.deps);
    expect(api.calls("GET", STACK_RUN)).toHaveLength(0);
    expect(h.clock.slept).toEqual([]);
  });

  test("--no-wait returns right after the app deploy is queued", async () => {
    const h = harness();
    const api = world({ apps: [APP] });
    await runUp(api, TID, flags({ wait: false }), "text", h.deps);
    expect(api.calls("GET", APP_RUN)).toHaveLength(0);
    expect(h.clock.slept).toEqual([]);
  });

  test("a failed stack deployment exits 1", async () => {
    const e = await rejected(
      runUp(world({ groups: [STACK], stackStatus: "failed" }), TID, flags(), "text", harness().deps),
    );
    expect(e.exitCode).toBe(1);
    expect(e.message).toBe("stack failed");
  });

  test("a partial stack deployment exits 1", async () => {
    const e = await rejected(
      runUp(world({ groups: [STACK], stackStatus: "partial" }), TID, flags(), "text", harness().deps),
    );
    expect(e.exitCode).toBe(1);
  });

  test("a failed app deployment exits 1", async () => {
    const e = await rejected(
      runUp(world({ apps: [APP], appStatus: "failed" }), TID, flags(), "text", harness().deps),
    );
    expect(e.exitCode).toBe(1);
    expect(e.message).toBe("deployment d-1 failed");
  });

  test("a stack that never finishes exits 12 after --wait-timeout", async () => {
    const e = await rejected(
      runUp(
        world({ groups: [STACK], stackStatus: "running" }),
        TID,
        flags({ waitTimeout: "8" }),
        "text",
        harness().deps,
      ),
    );
    expect(e.exitCode).toBe(12);
  });

  test("an app that never finishes exits 12 after --wait-timeout", async () => {
    const e = await rejected(
      runUp(
        world({ apps: [APP], appStatus: "building" }),
        TID,
        flags({ waitTimeout: "5" }),
        "text",
        harness().deps,
      ),
    );
    expect(e.exitCode).toBe(12);
  });
});

describe("json output", () => {
  test("a first run prints one object describing what was created and deployed", async () => {
    const h = harness();
    await runUp(world(), TID, flags({ server: "srv" }), "json", h.deps);
    expect(h.out.lines).toEqual([]);
    expect(h.out.objects).toHaveLength(1);
    const obj = h.out.objects[0]?.obj as Record<string, unknown>;
    expect(obj["action"]).toBe("create");
    expect(obj["kind"]).toBe("stack");
    expect(obj["target"]).toEqual({ id: "g-1", slug: "web" });
    expect(obj["repository"]).toEqual({ id: REPO.id, full_name: "acme/web" });
    expect(obj["deployment_error"]).toBeNull();
  });

  test("a failed deployment still prints the object, then exits 1", async () => {
    const h = harness();
    const e = await rejected(
      runUp(world({ apps: [APP], appStatus: "failed" }), TID, flags(), "json", h.deps),
    );
    expect(e.exitCode).toBe(1);
    const obj = h.out.objects[0]?.obj as Record<string, unknown>;
    expect(obj["action"]).toBe("deploy");
    expect(obj["deployment_error"]).toBe("deployment d-1 failed");
  });
});
