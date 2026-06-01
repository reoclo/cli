import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withFileLock, LockTimeoutError } from "../../../src/config/file-lock";

function tmpLock(): string {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  return join(dir, "nested", "x.lock"); // nested dir exercises mkdir -p
}

describe("withFileLock", () => {
  test("runs fn and removes the lock file after success", async () => {
    const lp = tmpLock();
    const r = await withFileLock(lp, () => Promise.resolve(42));
    expect(r).toBe(42);
    expect(existsSync(lp)).toBe(false);
  });

  test("removes the lock file even when fn throws", async () => {
    const lp = tmpLock();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's .rejects matcher types as void, not a Promise; await is harmless
    await expect(withFileLock(lp, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(existsSync(lp)).toBe(false);
  });

  test("serializes concurrent holders (mutual exclusion)", async () => {
    const lp = tmpLock();
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });

    const a = withFileLock(
      lp,
      async () => {
        order.push("A:start");
        await held;
        order.push("A:end");
      },
      { retryMs: 5 },
    );

    await new Promise((r) => setTimeout(r, 20)); // let A acquire
    const b = withFileLock(
      lp,
      () => {
        order.push("B:run");
        return Promise.resolve();
      },
      { retryMs: 5 },
    );

    await new Promise((r) => setTimeout(r, 20)); // B should still be blocked
    expect(order).toEqual(["A:start"]);

    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["A:start", "A:end", "B:run"]);
  });

  test("throws LockTimeoutError when a fresh lock can't be acquired in time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-"));
    const lp = join(dir, "x.lock");
    writeFileSync(lp, ""); // held by a (fresh) peer, never released

    let ran = false;
    const err = await withFileLock(
      lp,
      () => {
        ran = true;
        return Promise.resolve();
      },
      { timeoutMs: 40, retryMs: 5, staleMs: 60_000 },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LockTimeoutError);
    expect(ran).toBe(false); // fn must NOT run when the lock wasn't acquired
    expect(existsSync(lp)).toBe(true); // peer's lock left intact
  });

  test("creates the lock file with 0600 permissions", async () => {
    const lp = tmpLock();
    let mode = 0;
    await withFileLock(lp, () => {
      mode = statSync(lp).mode & 0o777;
      return Promise.resolve();
    });
    expect(mode).toBe(0o600);
  });

  test("steals a stale lock and proceeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-"));
    const lp = join(dir, "x.lock");
    writeFileSync(lp, "");
    const past = new Date(Date.now() - 60_000);
    utimesSync(lp, past, past);

    let ran = false;
    await withFileLock(
      lp,
      () => {
        ran = true;
        return Promise.resolve();
      },
      { staleMs: 1000, retryMs: 5 },
    );
    expect(ran).toBe(true);
    expect(existsSync(lp)).toBe(false);
  });
});
