// src/ui/prompt.ts

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

/** Ask a yes/no question on the TTY. Returns false immediately when stdin
 *  is not a TTY (non-interactive callers must opt in another way). */
export async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
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

/** Present a numbered menu and return the chosen 0-based index. Returns
 *  `defaultIndex` immediately when stdin is not a TTY. `labels` is rendered
 *  1-based; the default option is marked. */
export async function promptChoice(
  title: string,
  labels: string[],
  defaultIndex = 0,
): Promise<number> {
  if (!process.stdin.isTTY || labels.length === 0) return defaultIndex;
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
