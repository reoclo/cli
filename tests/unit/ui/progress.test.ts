import { afterEach, beforeEach, expect, test } from "bun:test";
import { createProgress } from "../../../src/ui/progress";

type WriteFn = typeof process.stdout.write;

function captureStdout(): { restore: () => void; output: () => string } {
  const original: WriteFn = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((s: string | Uint8Array) => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
    return true;
  }) as WriteFn;
  return {
    restore: () => {
      process.stdout.write = original;
    },
    output: () => chunks.join(""),
  };
}

let cap: ReturnType<typeof captureStdout>;
beforeEach(() => {
  cap = captureStdout();
});
afterEach(() => {
  cap.restore();
});

test("non-TTY: prints simple Downloading/done lines", () => {
  // In bun test, process.stdout.isTTY is undefined → non-TTY branch.
  const p = createProgress(1024, "Fetching foo");
  p.update(256);
  p.update(1024);
  p.finish();
  const out = cap.output();
  expect(out).toContain("Fetching foo...");
  expect(out).toMatch(/1\.0 KiB in \d+s/);
});

test("non-TTY: finish() is idempotent", () => {
  const p = createProgress(100, "x");
  p.finish();
  p.finish();
  const lines = cap.output().split("\n").filter(Boolean);
  // 1 "Downloading…" line + 1 "done in …" line = 2
  expect(lines.length).toBe(2);
});

test("non-TTY: unknown total still works", () => {
  const p = createProgress(null, "Streaming");
  p.update(42);
  p.finish();
  expect(cap.output()).toContain("Streaming...");
  expect(cap.output()).toContain("42 B");
});
