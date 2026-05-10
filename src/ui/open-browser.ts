// src/ui/open-browser.ts
import { spawn } from "node:child_process";
import { platform } from "node:process";

/**
 * Best-effort: open `url` in the user's default browser.
 * Returns true if the platform-specific launcher was spawned (success or not
 * actually verifiable without waiting). Returns false on unsupported platform
 * or when caller signals SSH/non-graphical context via env.
 *
 * Suppresses errors: the URL is also printed by the caller, so failure is
 * non-fatal — the user can copy/paste manually.
 */
export function openBrowser(url: string): boolean {
  if (isHeadlessSession()) return false;

  let cmd: string;
  let args: string[];
  switch (platform) {
    case "darwin":
      cmd = "open";
      args = [url];
      break;
    case "win32":
      // `start` is a cmd builtin, not an executable — needs cmd.exe.
      // The empty "" is the window-title arg (positional) so URLs starting
      // with quotes don't get treated as the title.
      cmd = "cmd";
      args = ["/c", "start", '""', url];
      break;
    case "linux":
    case "freebsd":
    case "openbsd":
      cmd = "xdg-open";
      args = [url];
      break;
    default:
      return false;
  }

  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      // launcher missing (e.g. xdg-open not installed) — caller already
      // printed the URL, nothing else to do.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Treat the environment as headless if obvious SSH/CI markers are set OR
 * the user explicitly opted out via REOCLO_NO_BROWSER. Linux: also check
 * for DISPLAY/WAYLAND_DISPLAY so we don't fire xdg-open on a bare TTY box.
 */
function isHeadlessSession(): boolean {
  const env = process.env;
  if (env["REOCLO_NO_BROWSER"]) return true;
  if (env["CI"]) return true;
  if (env["SSH_CONNECTION"] || env["SSH_CLIENT"] || env["SSH_TTY"]) return true;
  if (platform === "linux" && !env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) {
    return true;
  }
  return false;
}
