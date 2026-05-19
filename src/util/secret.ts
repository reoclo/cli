// src/util/secret.ts
//
// Read a secret value (registry credential password) either from stdin
// (`--password-stdin`) or via a masked TTY prompt. Tests target the stream
// reader directly; the public `readSecret` orchestrates the TTY-vs-stdin
// decision.

export class MissingSecretError extends Error {
  exitCode = 5;
  constructor(message = "password required: pass --password-stdin or run interactively") {
    super(message);
    this.name = "MissingSecretError";
  }
}

/** Read a stream to EOF and return the trimmed-of-trailing-newline string. */
export async function readSecretFromStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const trimmed = raw.replace(/\r?\n$/, "");
  if (trimmed.length === 0) {
    throw new MissingSecretError("--password-stdin: empty input");
  }
  return trimmed;
}

/** Masked TTY prompt — bun-friendly readline with output suppressed. */
async function promptMasked(label: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const origWrite = process.stdout.write.bind(process.stdout);
    let muted = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout.write as any) = (chunk: unknown, ...args: unknown[]): boolean => {
      if (!muted) {
        return origWrite(chunk as Buffer | string, ...(args as []));
      }
      return true;
    };
    rl.question(`${label}: `, (answer) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout.write as any) = origWrite;
      origWrite("\n");
      rl.close();
      const trimmed = answer.trim();
      if (trimmed.length === 0) {
        reject(new MissingSecretError("password required: prompt returned empty"));
        return;
      }
      resolve(trimmed);
    });
    muted = true;
  });
}

export interface ReadSecretOpts {
  /** True when the user passed --password-stdin. */
  fromStdin: boolean;
  /** Prompt label for TTY mode (e.g. "registry password"). */
  promptLabel?: string;
}

/**
 * Resolve a secret from either stdin (when fromStdin=true) or a masked TTY
 * prompt. Throws MissingSecretError when neither path can produce a value.
 */
export async function readSecret(opts: ReadSecretOpts): Promise<string> {
  if (opts.fromStdin) {
    return readSecretFromStream(process.stdin);
  }
  if (!process.stdin.isTTY) {
    throw new MissingSecretError();
  }
  return promptMasked(opts.promptLabel ?? "password");
}
