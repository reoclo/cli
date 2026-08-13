// src/ui/interactive.ts
//
// Thin, TTY-guarded wrapper over @clack/prompts so commands stay unit-testable
// and non-interactive/CI runs never block on a prompt. Every prompt returns a
// caller-supplied fallback when stdin is not a TTY. A Ctrl-C (clack cancel)
// aborts the process cleanly rather than returning a half-answer.
import {
  intro, outro, log, note, spinner,
  confirm, select, multiselect, isCancel, cancel,
} from "@clack/prompts";

export { intro, outro, log, note };

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function abortIfCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exit(130); // 128 + SIGINT
  }
  return value;
}

export async function confirmPrompt(
  message: string,
  opts: { initialValue?: boolean; fallback?: boolean } = {},
): Promise<boolean> {
  if (!isInteractive()) return opts.fallback ?? false;
  return abortIfCancelled(await confirm({ message, initialValue: opts.initialValue ?? true }));
}

export async function selectPrompt<T>(
  message: string,
  options: { value: T; label: string; hint?: string }[],
  initialValue: T,
): Promise<T> {
  if (!isInteractive()) return initialValue;
  return abortIfCancelled(
    await select<T>({ message, options: options as Parameters<typeof select<T>>[0]["options"], initialValue }),
  );
}

export async function multiSelectPrompt<T>(
  message: string,
  options: { value: T; label: string }[],
  initialValues: T[],
): Promise<T[]> {
  if (!isInteractive()) return initialValues;
  return abortIfCancelled(
    await multiselect<T>({
      message,
      options: options as Parameters<typeof multiselect<T>>[0]["options"],
      initialValues,
      required: false,
    }),
  );
}

export async function withSpinner<T>(message: string, fn: () => Promise<T>, done?: string): Promise<T> {
  if (!isInteractive()) return fn();
  const s = spinner();
  s.start(message);
  try {
    const result = await fn();
    s.stop(done ?? message);
    return result;
  } catch (e) {
    s.stop((e as Error).message);
    throw e;
  }
}
