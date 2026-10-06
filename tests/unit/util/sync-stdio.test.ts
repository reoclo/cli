import { describe, expect, test } from "bun:test";
import { writeFully } from "../../../src/util/sync-stdio";

function errno(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe("writeFully", () => {
  test("keeps writing until every byte is out, across partial writes", () => {
    const data = new Uint8Array(100_000).fill(7);
    const seen: number[] = [];
    const ok = writeFully(1, data, (_fd, _buf, offset) => {
      const n = Math.min(65_536, data.length - offset);
      seen.push(n);
      return n;
    });
    expect(ok).toBe(true);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(100_000);
    expect(seen.length).toBe(2);
  });

  test("waits out a full pipe (EAGAIN) and resumes at the same offset", () => {
    const data = new Uint8Array(10);
    const offsets: number[] = [];
    let blocked = 0;
    let pauses = 0;
    const ok = writeFully(
      1,
      data,
      (_fd, _buf, offset) => {
        offsets.push(offset);
        if (offset === 4 && blocked < 2) {
          blocked++;
          throw errno("EAGAIN");
        }
        return offset === 0 ? 4 : data.length - offset;
      },
      () => {
        pauses++;
      },
    );
    expect(ok).toBe(true);
    expect(pauses).toBe(2);
    expect(offsets).toEqual([0, 4, 4, 4]);
  });

  test("a reader that went away (EPIPE) ends the write quietly", () => {
    const ok = writeFully(1, new Uint8Array(10), () => {
      throw errno("EPIPE");
    });
    expect(ok).toBe(false);
  });

  test("any other error propagates", () => {
    expect(() =>
      writeFully(1, new Uint8Array(10), () => {
        throw errno("EIO");
      }),
    ).toThrow("EIO");
  });
});
