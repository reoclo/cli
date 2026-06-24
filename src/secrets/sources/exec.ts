// src/secrets/sources/exec.ts
//
// The subprocess seam for import source adapters. Adapters depend on the
// `CommandRunner` type, not on Bun.spawn directly, so tests inject a fake.

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  cmd: string[],
  opts?: { env?: Record<string, string | undefined> },
) => Promise<CommandResult>;

/**
 * Default runner. Spawns `cmd`, captures stdout/stderr as text, and resolves
 * with the exit code. `Bun.spawn` throws synchronously with `code === "ENOENT"`
 * when `cmd[0]` is not on PATH — that error propagates to the caller (the
 * async function turns it into a rejected promise), and adapters map it to a
 * friendly install hint.
 */
export const runCommand: CommandRunner = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, {
    env: opts?.env ?? process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};
