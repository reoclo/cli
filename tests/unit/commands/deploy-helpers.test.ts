import { describe, expect, test } from "bun:test";
import {
  assertDeploySucceeded,
  deployApp,
  isFailedDeployStatus,
} from "../../../src/commands/apps";
import { deployStack } from "../../../src/commands/groups";
import { FakeApi, FakeClock, TID, collectIo } from "../../helpers/fake-api";

const GROUP = "g-1";
const GROUP_DEPLOY = `/tenants/${TID}/application-groups/${GROUP}/deploy`;
const GD_PATH = `/tenants/${TID}/application-groups/${GROUP}/deployments/gd-1`;
const APP = "a-1";
const APP_DEPLOY = `/tenants/${TID}/applications/${APP}/deploy`;
const APP_DEP_PATH = `/tenants/${TID}/applications/${APP}/deployments/d-1`;

function sequence<T>(states: T[]): () => T {
  let i = 0;
  return () => states[Math.min(i++, states.length - 1)] as T;
}

async function rejected(p: Promise<unknown>): Promise<Error & { exitCode?: number }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { exitCode?: number };
  }
  throw new Error("expected the promise to reject");
}

const TRIGGER = { total: 2, triggered: 2, skipped: 0, group_deployment_id: "gd-1" };

describe("deployStack", () => {
  test("without wait it only triggers, and sends force_recreate only when asked", async () => {
    const api = new FakeApi().on("POST", GROUP_DEPLOY, TRIGGER);
    const out = collectIo();
    const plain = await deployStack(api, TID, GROUP, { waitTimeoutSeconds: 600, fmt: "text" }, { io: out.io });
    await deployStack(
      api,
      TID,
      GROUP,
      { forceRecreate: true, waitTimeoutSeconds: 600, fmt: "text" },
      { io: out.io },
    );
    expect(plain.finished).toBeNull();
    expect(api.requests.map((r) => r.body)).toEqual([undefined, { force_recreate: true }]);
    expect(api.requests.every((r) => r.method === "POST")).toBe(true);
    expect(out.objects).toHaveLength(2);
  });

  test("with wait it polls every 5s, reports each stage change and returns the finished run", async () => {
    const api = new FakeApi()
      .on("POST", GROUP_DEPLOY, TRIGGER)
      .on(
        "GET",
        GD_PATH,
        sequence([
          { id: "gd-1", deployment_number: 4, status: "running", stages: [{ name: "build", status: "running" }] },
          {
            id: "gd-1",
            deployment_number: 4,
            status: "succeeded",
            stages: [{ name: "build", status: "succeeded", duration_ms: 2314 }],
          },
        ]),
      );
    const out = collectIo();
    const clock = new FakeClock();
    const result = await deployStack(
      api,
      TID,
      GROUP,
      { wait: true, waitTimeoutSeconds: 600, fmt: "text" },
      { io: out.io, sleep: clock.sleep, now: clock.now },
    );
    expect(clock.slept).toEqual([5000, 5000]);
    expect(out.lines).toEqual([
      "stage build: running",
      "stage build: succeeded (2.3s)",
      "deployment #4: succeeded",
    ]);
    expect(result.finished?.status).toBe("succeeded");
  });

  test("a failed run throws with exit code 1 and the run's error", async () => {
    const api = new FakeApi().on("POST", GROUP_DEPLOY, TRIGGER).on("GET", GD_PATH, {
      id: "gd-1",
      deployment_number: 2,
      status: "failed",
      error_message: "build failed",
    });
    const clock = new FakeClock();
    const e = await rejected(
      deployStack(
        api,
        TID,
        GROUP,
        { wait: true, waitTimeoutSeconds: 600, fmt: "text" },
        { io: collectIo().io, sleep: clock.sleep, now: clock.now },
      ),
    );
    expect(e.exitCode).toBe(1);
    expect(e.message).toBe("build failed");
  });

  test("a cancelled run is a failure without an error message", async () => {
    const api = new FakeApi()
      .on("POST", GROUP_DEPLOY, TRIGGER)
      .on("GET", GD_PATH, { id: "gd-1", deployment_number: 2, status: "cancelled" });
    const clock = new FakeClock();
    const e = await rejected(
      deployStack(
        api,
        TID,
        GROUP,
        { wait: true, waitTimeoutSeconds: 600, fmt: "text" },
        { io: collectIo().io, sleep: clock.sleep, now: clock.now },
      ),
    );
    expect(e.exitCode).toBe(1);
    expect(e.message).toBe("group deployment finished cancelled");
  });

  test("a run that never finishes times out with exit code 12", async () => {
    const api = new FakeApi()
      .on("POST", GROUP_DEPLOY, TRIGGER)
      .on("GET", GD_PATH, { id: "gd-1", deployment_number: 2, status: "running" });
    const clock = new FakeClock();
    const e = await rejected(
      deployStack(
        api,
        TID,
        GROUP,
        { wait: true, waitTimeoutSeconds: 12, fmt: "text" },
        { io: collectIo().io, sleep: clock.sleep, now: clock.now },
      ),
    );
    expect(e.exitCode).toBe(12);
    expect(e.message).toBe("timed out after 12s waiting for group deployment gd-1");
    expect(clock.slept).toEqual([5000, 5000, 5000]);
  });

  test("a trigger without a group deployment id returns without polling", async () => {
    const api = new FakeApi().on("POST", GROUP_DEPLOY, { total: 0, triggered: 0, skipped: 2 });
    const clock = new FakeClock();
    const result = await deployStack(
      api,
      TID,
      GROUP,
      { wait: true, waitTimeoutSeconds: 600, fmt: "text" },
      { io: collectIo().io, sleep: clock.sleep, now: clock.now },
    );
    expect(result.finished).toBeNull();
    expect(clock.slept).toEqual([]);
  });

  test("non-text output prints the finished run as an object; quiet prints nothing", async () => {
    const run = { id: "gd-1", deployment_number: 2, status: "succeeded" };
    const api = new FakeApi().on("POST", GROUP_DEPLOY, TRIGGER).on("GET", GD_PATH, run);
    const clock = new FakeClock();
    const json = collectIo();
    await deployStack(
      api,
      TID,
      GROUP,
      { wait: true, waitTimeoutSeconds: 600, fmt: "json" },
      { io: json.io, sleep: clock.sleep, now: clock.now },
    );
    expect(json.objects.map((o) => o.obj)).toEqual([TRIGGER, run]);
    const quiet = collectIo();
    await deployStack(
      api,
      TID,
      GROUP,
      { wait: true, waitTimeoutSeconds: 600, fmt: "json", quiet: true },
      { io: quiet.io, sleep: clock.sleep, now: clock.now },
    );
    expect(quiet.objects).toEqual([]);
    expect(quiet.lines).toEqual([]);
  });
});

describe("deployApp", () => {
  test("without wait it queues the deployment and sends only the flags given", async () => {
    const api = new FakeApi().on("POST", APP_DEPLOY, { id: "d-1", status: "queued" });
    const out = collectIo();
    const result = await deployApp(api, TID, APP, { ref: "feat/x", forceRecreate: true }, { io: out.io });
    expect(api.requests[0]?.body).toEqual({ ref: "feat/x", force_recreate: true });
    expect(out.lines).toEqual(["✓ deployment d-1 queued (status: queued)"]);
    expect(result.finalStatus).toBeNull();
    await deployApp(api, TID, APP, {}, { io: out.io });
    expect(api.requests[1]?.body).toEqual({});
  });

  test("with wait it polls every 3s until the deployment succeeds", async () => {
    const api = new FakeApi()
      .on("POST", APP_DEPLOY, { id: "d-1", status: "queued" })
      .on("GET", APP_DEP_PATH, sequence([{ status: "building" }, { status: "succeeded" }]));
    const out = collectIo();
    const clock = new FakeClock();
    const result = await deployApp(api, TID, APP, { wait: true }, { io: out.io, sleep: clock.sleep, now: clock.now });
    expect(clock.slept).toEqual([3000, 3000]);
    expect(out.raws).toEqual([
      "\r  status: building   (3s)        ",
      "\r  status: succeeded   (6s)        ",
      "\n✓ succeeded\n",
    ]);
    expect(result.finalStatus).toBe("succeeded");
    assertDeploySucceeded(result);
  });

  test("a failed or cancelled deployment is returned, and assertDeploySucceeded turns it into exit 1", async () => {
    for (const status of ["failed", "cancelled"]) {
      const api = new FakeApi()
        .on("POST", APP_DEPLOY, { id: "d-1", status: "queued" })
        .on("GET", APP_DEP_PATH, { status });
      const out = collectIo();
      const clock = new FakeClock();
      const result = await deployApp(api, TID, APP, { wait: true }, { io: out.io, sleep: clock.sleep, now: clock.now });
      expect(result.finalStatus).toBe(status);
      expect(out.raws.at(-1)).toBe(`\n✗ ${status}\n`);
      let caught: (Error & { exitCode?: number }) | undefined;
      try {
        assertDeploySucceeded(result);
      } catch (e) {
        caught = e as Error & { exitCode?: number };
      }
      expect(caught?.exitCode).toBe(1);
      expect(caught?.message).toBe(`deployment d-1 ${status}`);
    }
  });

  test("a timeout stops the wait with exit code 12", async () => {
    const api = new FakeApi()
      .on("POST", APP_DEPLOY, { id: "d-1", status: "queued" })
      .on("GET", APP_DEP_PATH, { status: "building" });
    const clock = new FakeClock();
    const e = await rejected(
      deployApp(api, TID, APP, { wait: true, timeoutSeconds: 5 }, { io: collectIo().io, sleep: clock.sleep, now: clock.now }),
    );
    expect(e.exitCode).toBe(12);
    expect(e.message).toBe("timed out after 5s waiting for deployment d-1");
    expect(clock.slept).toEqual([3000, 3000]);
  });

  test("quiet prints nothing", async () => {
    const api = new FakeApi()
      .on("POST", APP_DEPLOY, { id: "d-1", status: "queued" })
      .on("GET", APP_DEP_PATH, { status: "succeeded" });
    const out = collectIo();
    const clock = new FakeClock();
    await deployApp(api, TID, APP, { wait: true, quiet: true }, { io: out.io, sleep: clock.sleep, now: clock.now });
    expect(out.lines).toEqual([]);
    expect(out.raws).toEqual([]);
  });

  test("isFailedDeployStatus", () => {
    expect(isFailedDeployStatus("failed")).toBe(true);
    expect(isFailedDeployStatus("cancelled")).toBe(true);
    expect(isFailedDeployStatus("succeeded")).toBe(false);
    expect(isFailedDeployStatus(null)).toBe(false);
  });
});
