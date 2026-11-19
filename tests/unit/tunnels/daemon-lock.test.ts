// tests/unit/tunnels/daemon-lock.test.ts
//
// The daemon's single-instance lock: who may take it, and what happens to a
// holder that is still running. Process checks are faked; the lock is a real file.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlreadyRunningError, takePidLock, type LockOptions } from "../../../src/tunnels/daemon";
import type { ProcessKind } from "../../../src/tunnels/instance";

const HOLDER = 4_000_000;

let dir: string;
let lock: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reoclo-lock-"));
  lock = join(dir, "tunneld.pid");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function holder(o: { running?: boolean; kind?: ProcessKind; answers?: boolean; stops?: boolean } = {}) {
  let running = o.running ?? true;
  const stopped: number[] = [];
  const opts: LockOptions = {
    alive: (pid) => pid === HOLDER && running,
    kind: () => Promise.resolve(o.kind ?? "daemon"),
    responding: () => Promise.resolve(o.answers ?? false),
    stop: (pid) => {
      stopped.push(pid);
      if (o.stops ?? true) running = false;
      return Promise.resolve(o.stops ?? true);
    },
    answerWaitMs: 50,
  };
  writeFileSync(lock, String(HOLDER));
  return { opts, stopped };
}

const owner = (): string => readFileSync(lock, "utf8");

describe("the daemon lock", () => {
  it("is taken when nobody holds it", async () => {
    await takePidLock(lock, join(dir, "sock"));
    expect(owner()).toBe(String(process.pid));
  });

  it("is taken from a holder that has exited", async () => {
    const { opts, stopped } = holder({ running: false });
    await takePidLock(lock, join(dir, "sock"), opts);
    expect(owner()).toBe(String(process.pid));
    expect(stopped).toEqual([]);
  });

  it("is taken from a pid that now belongs to another program, which is left running", async () => {
    const { opts, stopped } = holder({ kind: "other" });
    await takePidLock(lock, join(dir, "sock"), opts);
    expect(owner()).toBe(String(process.pid));
    expect(stopped).toEqual([]);
  });

  it("stays with a daemon that answers", async () => {
    const { opts, stopped } = holder({ answers: true });
    expect(await takePidLock(lock, join(dir, "sock"), opts).catch((e: unknown) => e)).toBeInstanceOf(AlreadyRunningError);
    expect(owner()).toBe(String(HOLDER));
    expect(stopped).toEqual([]);
  });

  it("is taken only after stopping a daemon that never answers", async () => {
    const { opts, stopped } = holder();
    await takePidLock(lock, join(dir, "sock"), opts);
    expect(stopped).toEqual([HOLDER]);
    expect(owner()).toBe(String(process.pid));
  });

  it("is taken without stopping a silent holder whose command line cannot be read", async () => {
    const { opts, stopped } = holder({ kind: "unknown" });
    await takePidLock(lock, join(dir, "sock"), opts);
    expect(stopped).toEqual([]);
    expect(owner()).toBe(String(process.pid));
  });

  it("is refused when a silent daemon cannot be stopped, so two never run at once", async () => {
    const { opts, stopped } = holder({ stops: false });
    const err = await takePidLock(lock, join(dir, "sock"), opts).catch((e: unknown) => e);
    expect((err as Error).message).toContain(`could not stop tunnel daemon pid ${HOLDER}`);
    expect(stopped).toEqual([HOLDER]);
    expect(owner()).toBe(String(HOLDER));
  });
});
