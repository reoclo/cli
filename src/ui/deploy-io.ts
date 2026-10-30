// src/ui/deploy-io.ts
//
// Output and timing seams for the deploy-and-wait loops, so the same loop
// serves the commands and the tests: the commands use the real stdout and a
// real sleep, tests pass collectors and a no-op sleep.
import { printObject, type OutputFormat } from "./output";

export interface DeployIo {
  /** One line of text output (a trailing newline is added). */
  line(text: string): void;
  /** Raw text, written as given (progress rewrites a line with \r). */
  raw(text: string): void;
  /** A structured object in the chosen output format. */
  object(obj: Record<string, unknown>, fmt: OutputFormat): void;
}

export const defaultIo: DeployIo = {
  line: (text) => console.log(text),
  raw: (text) => {
    process.stdout.write(text);
  },
  object: (obj, fmt) => printObject(obj, fmt),
};

export const silentIo: DeployIo = {
  line: () => undefined,
  raw: () => undefined,
  object: () => undefined,
};

export interface WaitDeps {
  /** Pause between polls. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock for timeouts and elapsed time. Defaults to Date.now. */
  now?: () => number;
  io?: DeployIo;
}

export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
