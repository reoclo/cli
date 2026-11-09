import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withConfigDir } from "../../../src/config/paths";
import {
  ForegroundNotFound,
  ForegroundRegistration,
  listForeground,
  stopForeground,
  type ForegroundTunnel,
  type StopDeps,
} from "../../../src/tunnels/foreground";
import { foregroundDir } from "../../../src/tunnels/paths";

let dir: string;
const inDir = <T>(fn: () => T): T => withConfigDir(dir, fn);
const forwards = [{ kind: "forward" as const, proto: "tcp" as const, listen: "127.0.0.1:7700", target: "127.0.0.1:7700" }];
const entry = (over: Partial<ForegroundTunnel> = {}): ForegroundTunnel => ({
  id: "4242",
  pid: 4242,
  org: "acme",
  server: "prod-1",
  state: "active",
  started_at: "2026-11-09T10:00:00.000Z",
  forwards,
  ...over,
});
const place = (name: string, body: string): void => {
  inDir(() => {
    mkdirSync(foregroundDir(), { recursive: true });
    writeFileSync(join(foregroundDir(), name), body);
  });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-fg-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the terminal tunnel registry", () => {
  it("lists a registered tunnel and forgets it when removed", () => {
    const reg = inDir(() => new ForegroundRegistration({ org: "acme", server: "prod-1", forwards }));
    const [listed] = inDir(() => listForeground());
    expect(listed?.pid).toBe(process.pid);
    expect(listed?.id).toBe(String(process.pid));
    expect(listed?.state).toBe("active");
    expect(listed?.forwards).toEqual(forwards);
    reg.remove();
    expect(inDir(() => listForeground())).toEqual([]);
  });

  it("records a reconnect", () => {
    const reg = inDir(() => new ForegroundRegistration({ org: "acme", server: "prod-1", forwards }));
    reg.setState("reconnecting");
    expect(inDir(() => listForeground())[0]?.state).toBe("reconnecting");
    reg.remove();
  });

  it("is empty before any tunnel has run", () => {
    expect(inDir(() => listForeground())).toEqual([]);
  });

  it("deletes the entry of a process that died without cleaning up", () => {
    place("4242.json", JSON.stringify(entry()));
    expect(inDir(() => listForeground(() => false))).toEqual([]);
    expect(inDir(() => readdirSync(foregroundDir()))).toEqual([]);
  });

  it("deletes a file it cannot read as an entry", () => {
    place("4242.json", "{not json");
    place("4243.json", JSON.stringify({ ...entry({ pid: 4243 }), forwards: [{ kind: "sideways" }] }));
    expect(inDir(() => listForeground(() => true))).toEqual([]);
    expect(inDir(() => readdirSync(foregroundDir()))).toEqual([]);
  });

  it("returns the oldest tunnel first", () => {
    place("2.json", JSON.stringify(entry({ pid: 2, started_at: "2026-11-09T12:00:00.000Z" })));
    place("1.json", JSON.stringify(entry({ pid: 1, started_at: "2026-11-09T09:00:00.000Z" })));
    expect(inDir(() => listForeground(() => true)).map((e) => e.pid)).toEqual([1, 2]);
  });
});

describe("stopping a terminal tunnel", () => {
  const deps = (command: string, code = 0): StopDeps & { killed: Array<[number, string]> } => {
    const killed: Array<[number, string]> = [];
    return {
      killed,
      list: () => [entry()],
      run: () => Promise.resolve({ code, stdout: command, stderr: "" }),
      kill: (pid, signal) => killed.push([pid, signal]),
    };
  };

  it("sends SIGTERM to a reoclo tunnel", async () => {
    const d = deps("/opt/homebrew/bin/reoclo --org envdev tunnel prod-1 -L 7700:127.0.0.1:7700\n");
    await stopForeground("4242", d);
    expect(d.killed).toEqual([[4242, "SIGTERM"]]);
  });

  it("leaves alone a process that took over the pid", async () => {
    const d = deps("/usr/bin/vim notes.txt\n");
    expect(stopForeground("4242", d)).rejects.toBeInstanceOf(ForegroundNotFound);
    await Promise.resolve();
    expect(d.killed).toEqual([]);
  });

  it("does not signal a process that is already gone", async () => {
    const d = deps("", 1);
    expect(stopForeground("4242", d)).rejects.toBeInstanceOf(ForegroundNotFound);
    await Promise.resolve();
    expect(d.killed).toEqual([]);
  });

  it("refuses an id it does not know", () => {
    const d = deps("reoclo tunnel");
    expect(stopForeground("9", d)).rejects.toBeInstanceOf(ForegroundNotFound);
  });

  it("removes its file on a normal exit path", () => {
    const reg = inDir(() => new ForegroundRegistration({ org: "acme", server: "prod-1", forwards }));
    const file = inDir(() => join(foregroundDir(), `${String(process.pid)}.json`));
    expect(existsSync(file)).toBe(true);
    reg.remove();
    expect(existsSync(file)).toBe(false);
  });
});
