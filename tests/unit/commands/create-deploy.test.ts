import { describe, expect, test } from "bun:test";
import { reportCreatedAndDeploy } from "../../../src/commands/apps";
import { runStacksCreate } from "../../../src/commands/groups";
import type { Application } from "../../../src/client/types";
import { FakeApi, FakeClock, SERVER_ID, TID, collectIo, repo, scan, service } from "../../helpers/fake-api";

const REPO = repo();
const SCAN_PATH = `/tenants/${TID}/repositories/${REPO.id}/scan-services`;
const WIZARD_PATH = `/tenants/${TID}/wizard/setup`;
const GROUP_DEPLOY = `/tenants/${TID}/application-groups/g-1/deploy`;
const GD_PATH = `/tenants/${TID}/application-groups/g-1/deployments/gd-1`;
const TARGET = { repositoryId: REPO.id, repositoryName: "web", serverId: SERVER_ID };

const WIZARD = {
  group: { id: "g-1", name: "web", slug: "web", kind: "compose" },
  created: [
    { id: "a-1", name: "web", slug: "web", status: "pending" },
    { id: "a-2", name: "db", slug: "db", status: "pending" },
  ],
  adopted: [],
  skipped: [],
};

function stackApi(finalStatus: string): FakeApi {
  return new FakeApi()
    .on("POST", SCAN_PATH, scan({ skipped_services: [{ name: "cache", reason: "no_build_context" }] }))
    .on("POST", WIZARD_PATH, WIZARD)
    .on("POST", GROUP_DEPLOY, { total: 2, triggered: 2, skipped: 0, group_deployment_id: "gd-1" })
    .on("GET", GD_PATH, { id: "gd-1", deployment_number: 1, status: finalStatus, error_message: "boom" });
}

async function rejected(p: Promise<unknown>): Promise<Error & { exitCode?: number }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { exitCode?: number };
  }
  throw new Error("expected the promise to reject");
}

describe("runStacksCreate", () => {
  test("creates the stack, deploys it and waits when --deploy --wait", async () => {
    const api = stackApi("succeeded");
    const out = collectIo();
    const clock = new FakeClock();
    await runStacksCreate(
      api,
      TID,
      TARGET,
      { deploy: true, wait: true, waitTimeout: "600" },
      "text",
      { io: out.io, sleep: clock.sleep, now: clock.now },
    );
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${SCAN_PATH}`,
      `POST ${WIZARD_PATH}`,
      `POST ${GROUP_DEPLOY}`,
      `GET ${GD_PATH}`,
    ]);
    expect(out.lines).toEqual([
      "✓ created stack web (id: g-1) with 2 service(s) from docker-compose.yml",
      "skipped cache: no_build_context",
      "deployment #1: succeeded",
    ]);
  });

  test("without --deploy it stops after creating the stack", async () => {
    const api = stackApi("succeeded");
    const out = collectIo();
    await runStacksCreate(api, TID, TARGET, { waitTimeout: "600" }, "text", { io: out.io });
    expect(api.calls("POST", GROUP_DEPLOY)).toHaveLength(0);
    expect(out.lines[0]).toContain("created stack web");
  });

  test("--wait without --deploy is refused before any request", async () => {
    const api = stackApi("succeeded");
    const e = await rejected(
      runStacksCreate(api, TID, TARGET, { wait: true, waitTimeout: "600" }, "text"),
    );
    expect(e.exitCode).toBe(2);
    expect(api.requests).toEqual([]);
  });

  test("a failed deployment exits 1 after the stack was created", async () => {
    const api = stackApi("failed");
    const clock = new FakeClock();
    const e = await rejected(
      runStacksCreate(
        api,
        TID,
        TARGET,
        { deploy: true, wait: true, waitTimeout: "600" },
        "text",
        { io: collectIo().io, sleep: clock.sleep, now: clock.now },
      ),
    );
    expect(e.exitCode).toBe(1);
    expect(e.message).toBe("boom");
    expect(api.calls("POST", WIZARD_PATH)).toHaveLength(1);
  });

  test("json output is one object holding the wizard result and the deployment", async () => {
    const api = stackApi("succeeded");
    const out = collectIo();
    const clock = new FakeClock();
    await runStacksCreate(
      api,
      TID,
      TARGET,
      { deploy: true, wait: true, waitTimeout: "600" },
      "json",
      { io: out.io, sleep: clock.sleep, now: clock.now },
    );
    expect(out.objects).toHaveLength(1);
    const obj = out.objects[0]?.obj as Record<string, unknown>;
    expect(obj["group"]).toEqual(WIZARD.group);
    expect(obj["deployment_error"]).toBeNull();
    expect((obj["deployment"] as { finished: { status: string } }).finished.status).toBe("succeeded");
  });

  test("json output still reports the stack when the deployment fails", async () => {
    const api = stackApi("failed");
    const out = collectIo();
    const clock = new FakeClock();
    const e = await rejected(
      runStacksCreate(
        api,
        TID,
        TARGET,
        { deploy: true, wait: true, waitTimeout: "600" },
        "json",
        { io: out.io, sleep: clock.sleep, now: clock.now },
      ),
    );
    expect(e.exitCode).toBe(1);
    const obj = out.objects[0]?.obj as Record<string, unknown>;
    expect(obj["deployment_error"]).toBe("boom");
    expect(obj["group"]).toEqual(WIZARD.group);
  });

  test("a compose file with several services but --compose-file for another one fails", async () => {
    const api = new FakeApi().on(
      "POST",
      SCAN_PATH,
      scan({ compose_files: ["a.yml", "b.yml"], services: [service()] }),
    );
    const e = await rejected(
      runStacksCreate(api, TID, TARGET, { composeFile: "c.yml", waitTimeout: "600" }, "text"),
    );
    expect(e.exitCode).toBe(2);
  });
});

describe("apps create --deploy", () => {
  const APP: Application = {
    id: "a-1",
    slug: "web",
    name: "Web",
    server_id: SERVER_ID,
    repository_id: REPO.id,
    current_deployment_id: null,
    created_at: "2026-10-30T00:00:00Z",
  };
  const DEPLOY = `/tenants/${TID}/applications/a-1/deploy`;
  const DEP = `/tenants/${TID}/applications/a-1/deployments/d-1`;

  function appApi(status: string): FakeApi {
    return new FakeApi()
      .on("POST", DEPLOY, { id: "d-1", status: "queued" })
      .on("GET", DEP, { status });
  }

  test("deploys with the ref and waits for success", async () => {
    const api = appApi("succeeded");
    const out = collectIo();
    const clock = new FakeClock();
    await reportCreatedAndDeploy(
      api,
      TID,
      APP,
      { ref: "feat/x", wait: true, waitTimeout: "600" },
      "text",
      { io: out.io, sleep: clock.sleep, now: clock.now },
    );
    expect(api.calls("POST", DEPLOY)[0]?.body).toEqual({ ref: "feat/x" });
    expect(out.lines).toEqual([
      "✓ created application web (id: a-1)",
      "✓ deployment d-1 queued (status: queued)",
    ]);
    expect(out.raws.at(-1)).toBe("\n✓ succeeded\n");
  });

  test("without --wait it only queues the deployment", async () => {
    const api = appApi("succeeded");
    const clock = new FakeClock();
    await reportCreatedAndDeploy(api, TID, APP, { waitTimeout: "600" }, "text", {
      io: collectIo().io,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(api.calls("GET", DEP)).toHaveLength(0);
    expect(clock.slept).toEqual([]);
  });

  test("a failed deployment exits 1", async () => {
    const api = appApi("failed");
    const clock = new FakeClock();
    const e = await rejected(
      reportCreatedAndDeploy(api, TID, APP, { wait: true, waitTimeout: "600" }, "text", {
        io: collectIo().io,
        sleep: clock.sleep,
        now: clock.now,
      }),
    );
    expect(e.exitCode).toBe(1);
  });

  test("a deployment that never finishes exits 12 after --wait-timeout", async () => {
    const api = appApi("building");
    const clock = new FakeClock();
    const e = await rejected(
      reportCreatedAndDeploy(api, TID, APP, { wait: true, waitTimeout: "5" }, "text", {
        io: collectIo().io,
        sleep: clock.sleep,
        now: clock.now,
      }),
    );
    expect(e.exitCode).toBe(12);
  });

  test("json output is one object with the application and the deployment", async () => {
    const api = appApi("succeeded");
    const out = collectIo();
    const clock = new FakeClock();
    await reportCreatedAndDeploy(api, TID, APP, { wait: true, waitTimeout: "600" }, "json", {
      io: out.io,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.objects).toHaveLength(1);
    const obj = out.objects[0]?.obj as Record<string, unknown>;
    expect(obj["application"]).toEqual(APP as unknown as Record<string, unknown>);
    expect(obj["deployment_error"]).toBeNull();
    expect((obj["deployment"] as { finalStatus: string }).finalStatus).toBe("succeeded");
    expect(out.lines).toEqual([]);
  });
});
