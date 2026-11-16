// src/util/secret.ts
//
// Read a secret value (a registry password, a storage secret key) either from
// stdin (`--password-stdin` or the command's own flag) or via a masked TTY prompt. Tests target the stream
// reader directly; the public `readSecret` orchestrates the TTY-vs-stdin
// decision.

import type { Interface as ReadLineInterface } from "node:readline";
import { noInputReason } from "../ui/tty";

export class MissingSecretError extends Error {
  exitCode = 5;
  constructor(message = "password required: pass --password-stdin or run interactively") {
    super(message);
    this.name = "MissingSecretError";
  }
}

/** Read a stream to EOF and return the trimmed-of-trailing-newline string. */
export async function readSecretFromStream(stream: NodeJS.ReadableStream, stdinFlag = "--password-stdin"): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const trimmed = raw.replace(/\r?\n$/, "");
  if (trimmed.length === 0) {
    throw new MissingSecretError(`${stdinFlag}: empty input`);
  }
  return trimmed;
}

export interface PromptDeps {
  /** Inject for testing; defaults to node:readline's createInterface. */
  createInterface?: (opts: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
    terminal: boolean;
  }) => ReadLineInterface;
}

/** Masked TTY prompt — readline with stdout muted during input. Exported for tests. */
export async function promptMasked(label: string, deps: PromptDeps = {}): Promise<string> {
  const createInterface: PromptDeps["createInterface"] =
    deps.createInterface ??
    (await import("node:readline").then((m) => m.createInterface));

  return new Promise((resolve, reject) => {
    const rl = createInterface!({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const origWrite = process.stdout.write;
    let restored = false;
    const restore = (): void => {
      if (restored) return;
      restored = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout.write as any) = origWrite;
    };

    let answered = false;
    let muted = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout.write as any) = (chunk: unknown, ...args: unknown[]): boolean => {
      if (!muted) {
        return origWrite.call(process.stdout, chunk as Buffer | string, ...(args as []));
      }
      return true;
    };

    rl.on("close", () => {
      restore();
      if (!answered) {
        reject(new MissingSecretError(`${label} prompt closed before input`));
      }
    });

    rl.on("error", (err: Error) => {
      restore();
      if (!answered) {
        reject(err);
      }
    });

    rl.question(`${label}: `, (answer) => {
      answered = true;
      restore();
      origWrite.call(process.stdout, "\n");
      rl.close();
      const trimmed = answer.trim();
      if (trimmed.length === 0) {
        reject(new MissingSecretError(`${label} required: prompt returned empty`));
        return;
      }
      resolve(trimmed);
    });
    muted = true;
  });
}

export interface ReadSecretOpts {
  /** True when the user passed the stdin flag. */
  fromStdin: boolean;
  /** What the secret is called in prompts and errors (e.g. "registry password"). */
  promptLabel?: string;
  /** The flag that reads the secret from stdin, named in errors. Default --password-stdin. */
  stdinFlag?: string;
}

/**
 * Resolve a secret from either stdin (when fromStdin=true) or a masked TTY
 * prompt. Throws MissingSecretError when neither path can produce a value.
 */
export async function readSecret(opts: ReadSecretOpts): Promise<string> {
  if (opts.fromStdin) {
    return readSecretFromStream(process.stdin, opts.stdinFlag);
  }
  const label = opts.promptLabel ?? "password";
  // Agent shells and CI look like terminals but nobody answers there, so ask the shared check, not isTTY.
  const reason = noInputReason();
  if (reason !== null) {
    throw new MissingSecretError(`not prompting for the ${label}: ${reason}; pass ${opts.stdinFlag ?? "--password-stdin"}`);
  }
  return promptMasked(label);
}
