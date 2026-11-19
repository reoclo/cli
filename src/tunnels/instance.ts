// src/tunnels/instance.ts
//
// One tunnel daemon per state directory. Its pid file is the lock. These helpers
// say who holds the lock and stop a holder that no longer answers, so a takeover
// never leaves an old daemon running with the tunnels' ports still bound.

import { readFileSync } from "node:fs";
import { platform } from "node:os";
import { realRunner, type CommandRunner } from "./command-runner";

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function lockOwner(path: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** `other` means the pid now belongs to some other program; `unknown` means its command line could not be read. */
export type ProcessKind = "daemon" | "other" | "unknown";

export async function processKind(pid: number, runner: CommandRunner = realRunner): Promise<ProcessKind> {
  let command: string;
  if (platform() === "linux") {
    try {
      command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    } catch {
      return "unknown";
    }
  } else if (platform() === "win32") {
    return "unknown";
  } else {
    const r = await runner("ps", ["-o", "command=", "-p", String(pid)]);
    if (r.code !== 0) return "unknown";
    command = r.stdout;
  }
  return /\btunnel\s+daemon\s+run\b/.test(command) ? "daemon" : "other";
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function exitsWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

/** Ask `pid` to stop, then kill it if it is still running after `graceMs`. True once it is gone. */
export async function stopProcess(pid: number, graceMs = 5_000): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !pidAlive(pid);
  }
  if (await exitsWithin(pid, graceMs)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return !pidAlive(pid);
  }
  return exitsWithin(pid, 2_000);
}
