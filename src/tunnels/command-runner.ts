// src/tunnels/command-runner.ts
//
// How trust and the hosts-helper installer run system commands. Everything that
// reaches outside the process goes through a CommandRunner, so tests pass a fake
// and never touch a keychain, launchd or sudo.

import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  /** Hand the terminal to the command, so a keychain or sudo prompt can ask for a password. */
  inherit?: boolean;
}

export type CommandRunner = (cmd: string, args: string[], opts?: CommandOptions) => Promise<CommandResult>;

export const realRunner: CommandRunner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
    child.once("error", (err) => resolve({ code: 127, stdout, stderr: err.message }));
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/** Quote an argument for display in an error message. */
export function shellWords(cmd: string, args: readonly string[]): string {
  return [cmd, ...args].map((a) => (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
}
