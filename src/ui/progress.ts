// src/ui/progress.ts
import { isTTY, noColor } from "./tty";

const BAR_WIDTH = 30;
// 9 fractional cell steps for sub-character precision on TTYs that support them.
const BLOCKS = " ▏▎▍▌▋▊▉█";

const COLOR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
};

function color(code: string, s: string): string {
  return noColor() ? s : `${code}${s}${COLOR.reset}`;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r.toString().padStart(2, "0")}s`;
}

function renderBar(fraction: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const totalSteps = BAR_WIDTH * (BLOCKS.length - 1);
  const filledSteps = Math.floor(clamped * totalSteps);
  const fullCells = Math.floor(filledSteps / (BLOCKS.length - 1));
  const partialIdx = filledSteps % (BLOCKS.length - 1);
  const fullChar = BLOCKS[BLOCKS.length - 1] ?? "#";
  const partialChar = BLOCKS[partialIdx] ?? " ";
  let bar = fullChar.repeat(Math.min(fullCells, BAR_WIDTH));
  if (fullCells < BAR_WIDTH) {
    bar += partialChar;
    bar += " ".repeat(BAR_WIDTH - fullCells - 1);
  }
  return bar;
}

export interface ProgressRender {
  update(received: number): void;
  finish(): void;
  abort(reason?: string): void;
}

/**
 * Streaming progress bar for a download of `total` bytes.
 * On a non-TTY or unknown size, falls back to single start + done lines.
 */
export function createProgress(total: number | null, label = "Downloading"): ProgressRender {
  const tty = isTTY(process.stdout);
  const start = Date.now();
  let lastRender = 0;
  let lastReceived = 0;
  let active = true;

  if (!tty || !total || total <= 0) {
    process.stdout.write(`    ${label}...\n`);
    return {
      update(received: number) {
        lastReceived = received;
      },
      finish() {
        if (!active) return;
        active = false;
        const elapsed = Date.now() - start;
        process.stdout.write(`    ${fmtBytes(lastReceived)} in ${fmtDuration(elapsed)}\n`);
      },
      abort() {
        active = false;
      },
    };
  }

  const cols = process.stdout.columns ?? 80;

  function render(received: number, force: boolean): void {
    const now = Date.now();
    if (!force && now - lastRender < 50) return;
    lastRender = now;
    lastReceived = received;
    const fraction = total ? received / total : 0;
    const elapsedSec = (now - start) / 1000;
    const rate = elapsedSec > 0 ? received / elapsedSec : 0;
    const remainingMs = rate > 0 && total ? ((total - received) / rate) * 1000 : 0;
    const bar = renderBar(fraction);
    const pct = (fraction * 100).toFixed(1).padStart(5);
    const totalStr = total ? fmtBytes(total) : "?";
    const sep = color(COLOR.dim, " • ");
    const line =
      `\r    ${color(COLOR.cyan, `[${bar}]`)} ${pct}%` +
      `${sep}${fmtBytes(received)}/${totalStr}` +
      `${sep}${fmtBytes(rate)}/s` +
      `${sep}ETA ${fmtDuration(remainingMs)}`;
    // Pad to terminal width so we overwrite any leftover characters.
    const visibleLen = line.replace(/\x1b\[[0-9;]*m/g, "").length;
    const pad = Math.max(0, cols - 1 - visibleLen);
    process.stdout.write(line + " ".repeat(pad));
  }

  return {
    update(received: number) {
      if (!active) return;
      render(received, false);
    },
    finish() {
      if (!active) return;
      active = false;
      const elapsed = Date.now() - start;
      const totalBytes = total ?? lastReceived;
      const rate = elapsed > 0 ? totalBytes / (elapsed / 1000) : 0;
      const bar = renderBar(1);
      const sep = color(COLOR.dim, " • ");
      const line =
        `\r    ${color(COLOR.green, `[${bar}]`)} 100.0%` +
        `${sep}${fmtBytes(totalBytes)}` +
        `${sep}${fmtBytes(rate)}/s` +
        `${sep}${fmtDuration(elapsed)}`;
      const visibleLen = line.replace(/\x1b\[[0-9;]*m/g, "").length;
      const pad = Math.max(0, cols - 1 - visibleLen);
      process.stdout.write(line + " ".repeat(pad) + "\n");
    },
    abort(reason?: string) {
      if (!active) return;
      active = false;
      process.stdout.write("\r" + " ".repeat(cols - 1) + "\r");
      if (reason) process.stdout.write(`    ${reason}\n`);
    },
  };
}
