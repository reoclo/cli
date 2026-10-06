// src/util/sync-stdio.ts
//
// Make stdout/stderr writes synchronous when they are a pipe or a file.
//
// Why: under Bun, process.stdout.write() on a pipe queues the data and returns.
// A process.exit() that follows (the CLI has dozens, plus the top-level error
// handler) drops whatever the pipe had not yet taken, which is anything past
// the 64 KB pipe buffer: `reoclo api /openapi.json | jq` read a JSON document
// cut off at 65,497 characters. A file redirect was fine because file writes
// complete at once. Node makes pipe writes synchronous on POSIX for the same
// reason. A terminal is left alone: it is not affected and stays interactive.
//
// console.log() is covered too. Once process.stdout.write is replaced, Bun
// sends console.log down a separate queued path that loses data the same way,
// so the console methods are pointed at the synchronous writers.

import { writeSync } from "node:fs";
import { format } from "node:util";

type WriteFn = (fd: number, buf: Uint8Array, offset: number) => number;

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const defaultPause = (ms: number): void => {
  Atomics.wait(sleepCell, 0, 0, ms);
};

/**
 * Write all of `data` to `fd`, waiting out a full pipe (EAGAIN). Returns false
 * when the reader has gone away (EPIPE, e.g. `reoclo ... | head`): the rest is
 * dropped, as a CLI is expected to do. Any other error propagates.
 */
export function writeFully(
  fd: number,
  data: Uint8Array,
  write: WriteFn = (f, b, o) => writeSync(f, b, o),
  pause: (ms: number) => void = defaultPause,
): boolean {
  let offset = 0;
  while (offset < data.length) {
    try {
      offset += write(fd, data, offset);
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (code === "EAGAIN") {
        pause(1);
        continue;
      }
      if (code === "EPIPE") return false;
      throw e;
    }
  }
  return true;
}

function patchStream(stream: NodeJS.WriteStream, fd: number): void {
  let readerGone = false;
  const syncWrite = (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    const encoding = typeof encodingOrCb === "string" ? encodingOrCb : undefined;
    const done = typeof encodingOrCb === "function" ? encodingOrCb : cb;
    if (!readerGone) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk;
      if (!writeFully(fd, bytes)) readerGone = true;
    }
    if (done) queueMicrotask(() => done(null));
    return true;
  };
  stream.write = syncWrite;
}

/**
 * Switch stdout and stderr to synchronous writes where they are not a TTY.
 * Call once, first thing in the CLI entry point; a process that never calls it
 * (tests importing modules) keeps the stock streams.
 */
export function installSyncStdio(): void {
  const streams: Array<[NodeJS.WriteStream, number, string[]]> = [
    [process.stdout, 1, ["log", "info", "debug"]],
    [process.stderr, 2, ["error", "warn"]],
  ];
  for (const [stream, fd, methods] of streams) {
    if (stream.isTTY) continue;
    patchStream(stream, fd);
    for (const method of methods) {
      (console as unknown as Record<string, (...args: unknown[]) => void>)[method] = (
        ...args: unknown[]
      ) => {
        stream.write(`${format(...args)}\n`);
      };
    }
  }
}
