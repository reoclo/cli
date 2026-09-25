// src/client/verbose.ts
//
// Process-wide switch for the global --verbose flag. The root command's
// preAction hook calls setVerbose() once per invocation; HttpClient and the
// tenant_switch mint read verboseLogger() when they send, so a client built
// before the flag was applied still honours it. Lines go to stderr so they
// never mix into -o json / yaml output on stdout.

type LineWriter = (line: string) => void;

const stderrWriter: LineWriter = (line) => {
  process.stderr.write(`${line}\n`);
};

let logger: LineWriter | undefined;

export function setVerbose(on: boolean, write: LineWriter = stderrWriter): void {
  logger = on ? write : undefined;
}

/** The --verbose writer, or undefined when --verbose is off. */
export function verboseLogger(): LineWriter | undefined {
  return logger;
}
