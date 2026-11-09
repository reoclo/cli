// src/tunnels/foreground.ts
//
// A tunnel started with `reoclo tunnel <server> -L ...` is its own process, so the
// daemon would never hear of it. Each one leaves a small file in
// <stateDir>/run/foreground while it runs. A file rather than a socket message
// means it does not matter which of the two started first or whether the daemon
// restarts, and a tunnel that is killed outright is noticed from its dead pid.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realRunner, type CommandRunner } from "./command-runner";
import { foregroundDir } from "./paths";

export interface ForegroundForward {
  kind: "forward" | "reverse";
  proto: "tcp" | "udp";
  /** Where traffic enters: a local address for forward, an address on the server for reverse. */
  listen: string;
  /** Where traffic goes. */
  target: string;
}

export type ForegroundState = "active" | "reconnecting";

export interface ForegroundTunnel {
  id: string;
  pid: number;
  org: string;
  server: string;
  state: ForegroundState;
  started_at: string;
  forwards: ForegroundForward[];
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

function writeEntry(file: string, entry: ForegroundTunnel): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
  renameSync(tmp, file);
}

/** This process's entry, removed when the process exits for any reason short of a kill. */
export class ForegroundRegistration {
  private entry: ForegroundTunnel;
  private readonly file: string;
  private readonly onExit = (): void => this.remove();

  constructor(input: Pick<ForegroundTunnel, "org" | "server" | "forwards">) {
    const dir = foregroundDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, `${process.pid}.json`);
    this.entry = {
      ...input,
      id: String(process.pid),
      pid: process.pid,
      state: "active",
      started_at: new Date().toISOString(),
    };
    writeEntry(this.file, this.entry);
    process.once("exit", this.onExit);
  }

  setState(state: ForegroundState): void {
    if (state === this.entry.state) return;
    this.entry = { ...this.entry, state };
    writeEntry(this.file, this.entry);
  }

  remove(): void {
    process.off("exit", this.onExit);
    rmSync(this.file, { force: true });
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !isErrno(err, "ESRCH");
  }
}

function parseForward(value: unknown): ForegroundForward | undefined {
  const f = value as Partial<ForegroundForward> | null;
  if (
    (f?.kind === "forward" || f?.kind === "reverse") &&
    (f.proto === "tcp" || f.proto === "udp") &&
    typeof f.listen === "string" &&
    typeof f.target === "string"
  ) {
    return { kind: f.kind, proto: f.proto, listen: f.listen, target: f.target };
  }
  return undefined;
}

function parseEntry(text: string): ForegroundTunnel | undefined {
  let value: Partial<ForegroundTunnel> | null;
  try {
    value = JSON.parse(text) as Partial<ForegroundTunnel> | null;
  } catch {
    return undefined;
  }
  if (
    !value ||
    !Number.isInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.org !== "string" ||
    typeof value.server !== "string" ||
    (value.state !== "active" && value.state !== "reconnecting") ||
    typeof value.started_at !== "string" ||
    !Array.isArray(value.forwards)
  ) {
    return undefined;
  }
  const forwards = value.forwards.map(parseForward);
  if (forwards.some((f) => f === undefined)) return undefined;
  return {
    id: String(value.pid),
    pid: value.pid as number,
    org: value.org,
    server: value.server,
    state: value.state,
    started_at: value.started_at,
    forwards: forwards as ForegroundForward[],
  };
}

/** The tunnels running in terminals, oldest first. Entries whose process is gone are deleted. */
export function listForeground(alive: (pid: number) => boolean = pidAlive): ForegroundTunnel[] {
  const dir = foregroundDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (isErrno(err, "ENOENT")) return [];
    throw err;
  }
  const out: ForegroundTunnel[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if (isErrno(err, "ENOENT")) continue;
      throw err;
    }
    const entry = parseEntry(text);
    if (!entry || !alive(entry.pid)) {
      rmSync(file, { force: true });
      continue;
    }
    out.push(entry);
  }
  return out.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

export class ForegroundNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForegroundNotFound";
  }
}

export interface StopDeps {
  list: () => ForegroundTunnel[];
  run: CommandRunner;
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

const defaultStopDeps: StopDeps = {
  list: () => listForeground(),
  run: realRunner,
  kill: (pid, signal) => process.kill(pid, signal),
};

/** Ask a terminal tunnel to exit. A pid can be reused, so the process is checked before it is signalled. */
export async function stopForeground(id: string, deps: StopDeps = defaultStopDeps): Promise<void> {
  const entry = deps.list().find((e) => e.id === id);
  if (!entry) throw new ForegroundNotFound(`no terminal tunnel with id "${id}"`);
  const ps = await deps.run("ps", ["-p", String(entry.pid), "-o", "command="]);
  if (ps.code !== 0 || !/\breoclo\b.*\btunnel\b/.test(ps.stdout)) {
    throw new ForegroundNotFound(`process ${String(entry.pid)} is no longer a reoclo tunnel`);
  }
  try {
    deps.kill(entry.pid, "SIGTERM");
  } catch (err) {
    if (isErrno(err, "ESRCH")) throw new ForegroundNotFound(`no terminal tunnel with id "${id}"`);
    throw err;
  }
}
