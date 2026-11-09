import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "../../../src/tunnels/command-runner";
import { MAX_RESTART_DELAY_MS, ShareSupervisor, explainExit, serveArgs, type ShareSpec } from "../../../src/tunnels/shares";
import { Tailscale } from "../../../src/tunnels/tailscale";
import { ManualTimers } from "../../helpers/fake-pool";
import {
  Changes,
  FakeSpawner,
  FakeTailscaleRunner,
  SELF_DNS,
  STOPPED_STATUS,
  fakeTailscale,
  fireDelay,
  serveJson,
  statusJson,
} from "../../helpers/fake-tailscale";

let dir: string;
let pidFile: string;
let timers: ManualTimers;
let spawner: FakeSpawner;
let runner: FakeTailscaleRunner;
let changes: Changes;
let logs: string[];
let supervisors: ShareSupervisor[];

function make(o: { tailscale?: Tailscale; ps?: CommandRunner; killed?: Array<[number, string]> } = {}): ShareSupervisor {
  const s = new ShareSupervisor({
    tailscale: o.tailscale ?? fakeTailscale(runner),
    spawn: spawner.spawn,
    pidFile,
    timers,
    log: (l) => logs.push(l),
    onChange: changes.notify,
    runner: o.ps,
    kill: o.killed ? (pid, signal) => o.killed?.push([pid, signal]) : undefined,
  });
  supervisors.push(s);
  return s;
}

const web: ShareSpec = { name: "web", kind: "https", port: 443, upstream: 18443 };
const db: ShareSpec = { name: "db", kind: "tcp", port: 5432, upstream: 15432 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reoclo-shares-"));
  pidFile = join(dir, "run", "shares.json");
  timers = new ManualTimers();
  spawner = new FakeSpawner();
  runner = new FakeTailscaleRunner();
  changes = new Changes();
  logs = [];
  supervisors = [];
});
afterEach(async () => {
  for (const s of supervisors) await s.stopAll();
  rmSync(dir, { recursive: true, force: true });
});

/** Let every promise that is ready run, so a check that only awaits fakes has finished. */
const drainMicrotasks = (): Promise<void> => new Promise((r) => setImmediate(r));

const spawned = (n: number): Promise<void> => changes.until(() => spawner.procs.length >= n, `child ${n} to start`);

describe("serveArgs", () => {
  it("builds a foreground command for an https share, never --bg", () => {
    expect(serveArgs(web)).toEqual(["serve", "--https=443", "http://127.0.0.1:18443"]);
  });

  it("builds a foreground command for a tcp share", () => {
    expect(serveArgs(db)).toEqual(["serve", "--tcp=5432", "tcp://127.0.0.1:15432"]);
    expect(serveArgs(db)).not.toContain("--bg");
  });
});

describe("explainExit", () => {
  it("names the last line the child printed", () => {
    expect(explainExit({ code: 1, signal: null }, "starting\nerror: listener failed\n")).toBe("tailscale serve exited with code 1: error: listener failed");
  });

  it("says plainly when HTTPS certificates are off", () => {
    expect(explainExit({ code: 1, signal: null }, "Serve is not enabled: HTTPS is not enabled on your tailnet")).toContain("HTTPS certificates are not enabled for this tailnet");
  });

  it("reports a signal and silence", () => {
    expect(explainExit({ code: null, signal: "SIGKILL" }, "")).toBe("tailscale serve was stopped by SIGKILL");
  });
});

describe("starting a share", () => {
  it("spawns the foreground serve command, records the pid, and is active once the child says it is available", async () => {
    const sup = make();
    await sup.start(web);
    await spawned(1);
    expect(spawner.procs[0]?.bin).toBe("/fake/tailscale");
    expect(spawner.procs[0]?.args).toEqual(["serve", "--https=443", "http://127.0.0.1:18443"]);
    expect(sup.status("web")).toMatchObject({ state: "starting", url: `https://${SELF_DNS}:443`, restarts: 0 });
    expect(JSON.parse(readFileSync(pidFile, "utf8"))).toEqual({ shares: [{ pid: 40000, name: "web" }] });

    spawner.procs[0]?.say("\nAvailable within your tailnet:\n\nhttps://x\n");
    await changes.until(() => sup.status("web")?.state === "active", "the share to be active");
  });

  it("starts a tcp share and shows a tcp URL", async () => {
    const sup = make();
    await sup.start(db);
    await spawned(1);
    expect(spawner.procs[0]?.args).toEqual(["serve", "--tcp=5432", "tcp://127.0.0.1:15432"]);
    expect(sup.status("db")?.url).toBe(`tcp://${SELF_DNS}:5432`);
  });

  it("becomes active when serve status lists its port, even if the child printed nothing", async () => {
    const sup = make();
    await sup.start(db);
    await spawned(1);
    runner.serve = serveJson([{ port: 5432, tcp: "127.0.0.1:15432" }]);
    expect(fireDelay(timers, 1000)).toBe(1);
    await changes.until(() => sup.status("db")?.state === "active", "the share to be confirmed by serve status");
  });

  it("keeps checking serve status while the port is missing, and stops once the share is stopped", async () => {
    const sup = make();
    await sup.start(db);
    await spawned(1);
    for (let i = 0; i < 3; i++) {
      expect(fireDelay(timers, 1000)).toBe(1);
      await drainMicrotasks();
      expect(timers.pending.size).toBe(1);
      expect(sup.status("db")?.state).toBe("starting");
    }
    await sup.stop("db");
    expect(timers.pending.size).toBe(0);
  });

  it("replaces a share of the same name", async () => {
    const sup = make();
    await sup.start(db);
    await spawned(1);
    await sup.start({ ...db, port: 6000 });
    await spawned(2);
    expect(spawner.procs[0]?.killed).toEqual(["SIGTERM"]);
    expect(spawner.procs[1]?.args).toEqual(["serve", "--tcp=6000", "tcp://127.0.0.1:15432"]);
  });
});

describe("stopping a share", () => {
  it("terminates the child, clears the pid file and forgets the share", async () => {
    const sup = make();
    await sup.start(db);
    await spawned(1);
    await sup.stop("db");
    expect(spawner.procs[0]?.killed).toEqual(["SIGTERM"]);
    expect(existsSync(pidFile)).toBe(false);
    expect(sup.status("db")).toBeUndefined();
  });

  it("kills a child that ignores SIGTERM once the grace period ends", async () => {
    const sup = make();
    await sup.start(db);
    await spawned(1);
    const proc = spawner.procs[0];
    if (!proc) throw new Error("no child");
    proc.stubborn = true;
    const stopped = sup.stop("db");
    await changes.until(() => timers.pending.size > 0 && proc.killed.length === 1, "the grace timer");
    expect(fireDelay(timers, 3000)).toBe(1);
    await stopped;
    expect(proc.killed).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("stopAll ends every share", async () => {
    const sup = make();
    await sup.start(db);
    await sup.start(web);
    await spawned(2);
    await sup.stopAll();
    expect(spawner.procs.every((p) => p.killed.length === 1)).toBe(true);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("does not restart a share that is stopped while waiting to retry", async () => {
    const sup = make();
    await sup.start(db);
    await spawned(1);
    spawner.procs[0]?.exit(1);
    await changes.until(() => sup.status("db")?.state === "restarting", "the share to be restarting");
    await sup.stop("db");
    expect(fireDelay(timers, 1000)).toBe(0);
    expect(spawner.procs).toHaveLength(1);
  });
});

describe("a share that exits on its own", () => {
  it("shows why, restarts with doubling backoff capped at 30 seconds, and counts restarts", async () => {
    const sup = make();
    await sup.start(db);
    const delays: number[] = [];
    for (let i = 1; i <= 7; i++) {
      await spawned(i);
      spawner.procs[i - 1]?.say("error: serve config rejected\n");
      spawner.procs[i - 1]?.exit(1);
      await changes.until(() => sup.status("db")?.state === "restarting" && sup.status("db")?.restarts === i, `restart ${i} to be scheduled`);
      expect(sup.status("db")?.error).toBe("tailscale serve exited with code 1: error: serve config rejected");
      delays.push(timers.delays.at(-1) ?? 0);
      expect(fireDelay(timers, delays.at(-1) ?? 0)).toBe(1);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, MAX_RESTART_DELAY_MS, MAX_RESTART_DELAY_MS]);
  });

  it("resets the backoff once the share is active again", async () => {
    const sup = make();
    await sup.start(db);
    await spawned(1);
    spawner.procs[0]?.exit(1);
    await changes.until(() => sup.status("db")?.state === "restarting", "restart 1");
    fireDelay(timers, 1000);
    await spawned(2);
    spawner.procs[1]?.say("Available within your tailnet:");
    await changes.until(() => sup.status("db")?.state === "active", "active again");
    expect(sup.status("db")?.error).toBeUndefined();
    spawner.procs[1]?.exit(1);
    await changes.until(() => sup.status("db")?.state === "restarting", "restart 2");
    expect(timers.delays.at(-1)).toBe(1000);
  });

  it("removes the dead child's pid from the pid file", async () => {
    const sup = make();
    await sup.start(db);
    await spawned(1);
    spawner.procs[0]?.exit(0);
    await changes.until(() => sup.status("db")?.state === "restarting", "the share to be restarting");
    expect(existsSync(pidFile)).toBe(false);
  });
});

describe("what keeps a share from starting", () => {
  it("says Tailscale is missing, and starts nothing", async () => {
    const sup = make({ tailscale: new Tailscale({ runner: runner.runner, find: () => undefined }) });
    await sup.start(db);
    await changes.until(() => sup.status("db")?.state === "failed", "the share to fail");
    expect(sup.status("db")?.error).toContain("not installed");
    expect(spawner.procs).toHaveLength(0);
  });

  it("says Tailscale is stopped, then starts the share once it runs", async () => {
    runner.status = STOPPED_STATUS;
    const sup = make();
    await sup.start(db);
    await changes.until(() => sup.status("db")?.state === "failed", "the share to fail");
    expect(sup.status("db")?.error).toContain("not running (Stopped)");
    runner.status = statusJson();
    expect(fireDelay(timers, 1000)).toBe(1);
    await spawned(1);
    expect(sup.status("db")?.state).toBe("starting");
  });

  it("says HTTPS certificates are off for an https share only", async () => {
    runner.status = statusJson({ certDomains: null });
    const sup = make();
    await sup.start(web);
    await changes.until(() => sup.status("web")?.state === "failed", "the https share to fail");
    expect(sup.status("web")?.error).toContain("HTTPS certificates are not enabled");
    await sup.start(db);
    await spawned(1);
    expect(sup.status("db")?.state).toBe("starting");
  });

  it("says the port is already served by something else, and accepts a leftover of its own", async () => {
    runner.serve = serveJson([{ port: 443, proxy: "http://127.0.0.1:3000" }]);
    const sup = make();
    await sup.start(web);
    await changes.until(() => sup.status("web")?.state === "failed", "the share to fail");
    expect(sup.status("web")?.error).toContain("port 443 is already served");
    expect(sup.status("web")?.error).toContain("http://127.0.0.1:3000");
    expect(spawner.procs).toHaveLength(0);

    runner.serve = serveJson([{ port: 443, proxy: "http://127.0.0.1:18443" }]);
    expect(fireDelay(timers, 1000)).toBe(1);
    await spawned(1);
  });

  it("needs a name for this machine on the tailnet", async () => {
    runner.status = JSON.stringify({ BackendState: "Running", CertDomains: ["x"] });
    const sup = make();
    await sup.start(db);
    await changes.until(() => sup.status("db")?.state === "failed", "the share to fail");
    expect(sup.status("db")?.error).toContain("no name on the tailnet");
  });
});

describe("cleaning up after a crash", () => {
  function recorded(...pids: number[]): void {
    mkdirSync(join(dir, "run"), { recursive: true });
    writeFileSync(pidFile, JSON.stringify({ shares: pids.map((pid) => ({ pid, name: `s${pid}` })) }));
  }
  const ps =
    (commands: Record<string, string>): CommandRunner =>
    (cmd, args) =>
      Promise.resolve({ code: commands[args.at(-1) ?? ""] === undefined ? 1 : 0, stdout: commands[args.at(-1) ?? ""] ?? "", stderr: "" });

  it("stops the serve children it recorded, leaves a reused pid alone, and clears the file", async () => {
    recorded(501, 502, 503);
    const killed: Array<[number, string]> = [];
    const sup = make({
      killed,
      ps: ps({ "501": "/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --tcp=5432 tcp://127.0.0.1:15432", "502": "/usr/bin/vim notes.txt" }),
    });
    expect(await sup.cleanupStale()).toEqual([501]);
    expect(killed).toEqual([[501, "SIGTERM"]]);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("does nothing without a pid file, or with one it cannot read", async () => {
    const killed: Array<[number, string]> = [];
    const sup = make({ killed, ps: ps({}) });
    expect(await sup.cleanupStale()).toEqual([]);
    mkdirSync(join(dir, "run"), { recursive: true });
    writeFileSync(pidFile, "not json");
    expect(await sup.cleanupStale()).toEqual([]);
    expect(killed).toEqual([]);
  });

  it("kills nothing when it cannot check what a pid is", async () => {
    recorded(501);
    const killed: Array<[number, string]> = [];
    expect(await make({ killed }).cleanupStale()).toEqual([]);
    expect(killed).toEqual([]);
  });
});
