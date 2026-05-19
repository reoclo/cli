// src/ui/prompt.ts

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
