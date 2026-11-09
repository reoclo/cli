import { beforeEach, describe, expect, it } from "bun:test";
import { APPROVAL_TTL_MS, ApprovalStore, type ApprovalView } from "../../../src/tunnels/approvals";
import { ManagerError } from "../../../src/tunnels/manager";
import { ManualTimers } from "../../helpers/fake-pool";
import { messageOf, rejectionOf } from "../../helpers/rejection";

let now: number;
let timers: ManualTimers;
let changes: ApprovalView[];
let store: ApprovalStore;
let ids: number;

beforeEach(() => {
  now = Date.parse("2026-11-09T10:00:00Z");
  timers = new ManualTimers();
  changes = [];
  ids = 0;
  store = new ApprovalStore({
    now: () => now,
    timers,
    onChange: (a) => changes.push(a),
    newId: () => `a${++ids}`,
  });
});

const request = (run: () => Promise<unknown> = () => Promise.resolve("done")) => ({
  agent: "claude-code",
  action: "save_tunnel",
  description: "Save reverse tunnel hook",
  run,
});

describe("approval lifecycle", () => {
  it("records a pending approval that expires in ten minutes", () => {
    const a = store.create(request());
    expect(a).toMatchObject({ id: "a1", agent: "claude-code", status: "pending" });
    expect(Date.parse(a.expires_at) - Date.parse(a.created_at)).toBe(APPROVAL_TTL_MS);
    expect(timers.delays).toEqual([APPROVAL_TTL_MS]);
    expect(store.list().map((x) => x.id)).toEqual(["a1"]);
    expect(changes).toHaveLength(1);
  });

  it("runs the action once when approved and keeps its result", async () => {
    let runs = 0;
    store.create(request(() => Promise.resolve({ runs: ++runs })));
    const done = await store.approve("a1");
    expect(done).toMatchObject({ status: "approved", result: { runs: 1 } });
    expect(store.list()).toEqual([]);
    expect(store.list({ all: true }).map((x) => x.id)).toEqual(["a1"]);
    expect(timers.pending.size).toBe(0);
    expect(messageOf(await rejectionOf(store.approve("a1")))).toContain("already approved");
    expect(runs).toBe(1);
  });

  it("stores the failure when the approved action throws", async () => {
    store.create(request(() => Promise.reject(new ManagerError("not_found", "no tunnel named hook"))));
    const done = await store.approve("a1");
    expect(done.status).toBe("approved");
    expect(done.error).toEqual({ code: "not_found", message: "no tunnel named hook" });
    expect(done.result).toBeUndefined();
  });

  it("denies without running the action", async () => {
    let ran = false;
    store.create(request(() => ((ran = true), Promise.resolve())));
    expect(store.deny("a1").status).toBe("denied");
    expect(ran).toBe(false);
    const err = await rejectionOf(store.approve("a1"));
    expect(err).toMatchObject({ code: "conflict" });
    expect(messageOf(err)).toContain("already denied");
  });

  it("expires when the timer fires and refuses a late decision", async () => {
    store.create(request());
    timers.fire();
    expect(store.get("a1").status).toBe("expired");
    expect(changes.map((c) => c.status)).toEqual(["pending", "expired"]);
    expect(store.list()).toEqual([]);
    expect(messageOf(await rejectionOf(store.approve("a1")))).toContain("already expired");
  });

  it("expires on the clock even before the timer fires", () => {
    store.create(request());
    now += APPROVAL_TTL_MS;
    expect(store.get("a1").status).toBe("expired");
  });

  it("does not list an approval that is running, and refuses a second approve", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    store.create(request(() => gate.then(() => "ok")));
    const approving = store.approve("a1");
    expect(store.list()).toEqual([]);
    expect(messageOf(await rejectionOf(store.approve("a1")))).toContain("already being approved");
    release();
    expect((await approving).result).toBe("ok");
  });

  it("answers not_found for an unknown id", async () => {
    expect(await rejectionOf(Promise.resolve().then(() => store.get("nope")))).toMatchObject({ code: "not_found" });
  });

  it("drops decided approvals after an hour", async () => {
    store.create(request());
    await store.approve("a1");
    now += 60 * 60_000 + 1;
    store.create(request());
    expect(store.list({ all: true }).map((x) => x.id)).toEqual(["a2"]);
  });

  it("clears its timers on stop", () => {
    store.create(request());
    store.stop();
    expect(timers.pending.size).toBe(0);
  });
});
