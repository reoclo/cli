// src/ui/prompt.ts
import { noInputReason } from "./tty";

/**
 * Map a user's reply to a numbered menu (1-based) onto a 0-based index. An empty
 * reply, an out-of-range number, or non-numeric input all fall back to
 * `defaultIndex`.
 */
export function parseChoice(answer: string, count: number, defaultIndex: number): number {
  const trimmed = answer.trim();
  if (trimmed === "") return defaultIndex;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > count) return defaultIndex;
  return n - 1;
}

/** Ask a yes/no question on the TTY. Returns false at once, saying why on stderr, when no one can
 *  answer (see noInputReason); non-interactive callers must opt in another way, such as --yes. */
export async function promptYesNo(question: string): Promise<boolean> {
  const reason = noInputReason();
  if (reason !== null) {
    process.stderr.write(`not asking "${question.trim()}": ${reason}\n`);
    return false;
  }
  const { createInterface } = await import("node:readline");
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** True when the action may go ahead: `--yes` was passed, or the user answered
 *  yes on the TTY. When no one can answer and `--yes` is missing it is false, never a hang. */
export async function confirmAction(question: string, yes?: boolean): Promise<boolean> {
  if (yes) return true;
  return promptYesNo(question);
}

/** Gate a destructive command: returns when confirmed, otherwise prints the
 *  standard abort message and exits 1. */
export async function confirmOrExit(question: string, yes?: boolean): Promise<void> {
  if (await confirmAction(question, yes)) return;
  process.stderr.write("aborted (pass --yes to confirm non-interactively)\n");
  process.exit(1);
}

/** Present a numbered menu and return the chosen 0-based index. Returns
 *  `defaultIndex` immediately when no one can answer. `labels` is rendered
 *  1-based; the default option is marked. */
export async function promptChoice(
  title: string,
  labels: string[],
  defaultIndex = 0,
): Promise<number> {
  if (noInputReason() !== null || labels.length === 0) return defaultIndex;
  process.stdout.write(`${title}\n`);
  labels.forEach((label, i) => {
    const marker = i === defaultIndex ? " (default)" : "";
    process.stdout.write(`  ${i + 1}) ${label}${marker}\n`);
  });
  const { createInterface } = await import("node:readline");
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(`Choose [${defaultIndex + 1}]: `, (answer) => {
      rl.close();
      resolve(parseChoice(answer, labels.length, defaultIndex));
    });
  });
}
