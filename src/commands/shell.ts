// src/commands/shell.ts
import { type Command, Help } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { EXIT } from "../client/exit-codes";
import { resolveServer } from "../client/resolve";
import { withCompletion } from "../client/command-meta";

export const SUBPROTOCOL_VERSION = "v1";

/**
 * Map a gateway WebSocket close code onto the CLI's exit-code contract.
 *
 * `current` is whatever an `exited` frame already recorded — the child's own
 * exit code. A close that carries no failure of its own must leave it alone,
 * which is what a null `exitCode` means here.
 *
 * Extracted from the ws `close` handler so it can be tested: it lived in a
 * closure, and 4403 quietly returned AUTH(3) for months while an HTTP 403 —
 * the same condition — returned DENIED(4) via `mapHttpError`.
 */
export function shellCloseToExit(
  code: number,
  reason: string,
  current: number,
): { exitCode: number | null; message: string | null } {
  switch (code) {
    case 1000: // normal close
    case 1005: // no status — nothing to report
      return { exitCode: null, message: null };
    case 4001:
      return { exitCode: EXIT.AUTH, message: `[authentication failed: ${reason}]` };
    case 4403:
      // DENIED, not AUTH: authenticated, but not permitted. Mirrors HTTP 403.
      return { exitCode: EXIT.DENIED, message: `[forbidden: ${reason}]` };
    case 4404:
      return { exitCode: EXIT.NOT_FOUND, message: `[not found: ${reason}]` };
    case 4400:
      return { exitCode: EXIT.MISUSE, message: `[bad request: ${reason}]` };
    case 4408:
      // GENERIC, not NETWORK: the session lapsed; the control plane was reachable.
      return { exitCode: EXIT.GENERIC, message: "[idle timeout]" };
    default:
      // Report it, but never overwrite a non-zero code the child already set.
      return {
        exitCode: current === 0 ? EXIT.GENERIC : null,
        message: `[connection closed: ${code} ${reason}]`,
      };
  }
}

export function base64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function buildShellWsUrl(streamsUrl: string, serverId: string): string {
  const trimmed = streamsUrl.replace(/\/$/, "");
  const wsBase = trimmed.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  // The un-stripped automation path. The gateway strips the legacy /mcp prefix
  // and misroutes /mcp/ws/terminal to the human terminal handler (a 403 on any
  // gateway host); /api/automation/v1/* is passed through untouched. Requires
  // api >= 1.124.0. See reoclo/core DAV-192.
  return `${wsBase}/api/automation/v1/ws/terminal/${serverId}`;
}

export function buildShellSubprotocol(token: string): string {
  return `reoclo.api-key.${SUBPROTOCOL_VERSION}.${base64url(token)}`;
}

interface ShellOptions {
  allowNoTty?: boolean;
}

export function registerShell(program: Command): void {
  withCompletion(
    program
      .command("shell <serverIdOrName>")
      .description("open an interactive shell on a server via the runner")
      .option("--allow-no-tty", "skip the TTY-required check (mostly for tests, bypasses raw mode)")
      // Commander v12 quirk: addHelpText() output is NOT included in helpInformation();
      // override formatHelp so our Examples block appears in both `--help` and programmatic
      // help (which tests assert on).
      .configureHelp({
        formatHelp: (cmd, helper) => {
          const base = Help.prototype.formatHelp.call(helper, cmd, helper);
          return (
            base +
            [
              "",
              "Examples:",
              "  reoclo shell my-server",
              "  reoclo shell --allow-no-tty my-server   # mostly for tests",
              "",
            ].join("\n")
          );
        },
      })
      .action(async (idOrName: string, opts: ShellOptions) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        const ttyOk = stdin.isTTY === true && stdout.isTTY === true;

        if (!ttyOk && !opts.allowNoTty) {
          const e = new Error(
            "reoclo shell requires an interactive TTY — use 'reoclo exec' for one-shot commands",
          ) as Error & { exitCode: number };
          e.exitCode = 2;
          throw e;
        }

        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const serverId = await resolveServer(ctx.client, tid, idOrName);

        // Use the CF-bypass host (streams.reoclo.com in prod) so the WS
        // doesn't hit Cloudflare's ~100s idle reaper. In dev/staging this
        // resolves to the same host as the API.
        const wsUrl = buildShellWsUrl(ctx.streamsUrl, serverId);
        const subprotocol = buildShellSubprotocol(ctx.token);

        // Bun and modern Node both expose the browser WebSocket global.
        const ws = new WebSocket(wsUrl, [subprotocol]);
        ws.binaryType = "arraybuffer";

        let cleanedUp = false;
        const restoreTty = (): void => {
          if (cleanedUp) return;
          cleanedUp = true;
          if (ttyOk) {
            stdin.setRawMode?.(false);
            stdin.pause();
          }
          stdin.removeAllListeners("data");
          stdout.removeAllListeners("resize");
        };
        process.once("exit", restoreTty);

        let exitCode = 0;
        const closeAndExit = (code: number): void => {
          restoreTty();
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            try {
              ws.close(1000);
            } catch {
              // ignore
            }
          }
          exitCode = code;
        };

        const sendResize = (): void => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: stdout.columns ?? 80,
              rows: stdout.rows ?? 24,
            }),
          );
        };

        ws.addEventListener("open", () => {
          if (ttyOk) {
            stdin.setRawMode?.(true);
            stdin.resume();
          }
          sendResize();
          stdin.on("data", (chunk: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
          });
          stdout.on("resize", sendResize);
        });

        ws.addEventListener("message", (event: MessageEvent) => {
          const data = event.data as string | ArrayBuffer | Uint8Array | Blob;
          if (typeof data === "string") {
            // JSON control frame: {"type":"ready"} or {"type":"exited","exit_code":N}
            try {
              const msg = JSON.parse(data) as {
                type?: string;
                exit_code?: number;
                message?: string;
              };
              if (msg.type === "exited") {
                closeAndExit(msg.exit_code ?? 0);
              } else if (msg.type === "error") {
                process.stderr.write(`\n[server error: ${msg.message ?? "unknown"}]\n`);
                closeAndExit(1);
              }
              // 'ready' is informational; nothing to do.
            } catch {
              // ignore unparseable control frames
            }
          } else if (data instanceof ArrayBuffer) {
            stdout.write(Buffer.from(data));
          } else if (data instanceof Uint8Array) {
            stdout.write(Buffer.from(data));
          }
        });

        ws.addEventListener("error", () => {
          // Most useful error info comes via close; suppress here to avoid
          // double-printing.
        });

        const closed: Promise<void> = new Promise((resolve) => {
          ws.addEventListener("close", (event: CloseEvent) => {
            restoreTty();
            // Map server-side WS close codes to CLI exit codes. See
            // shellCloseToExit — kept pure so the mapping is testable.
            const { exitCode: mapped, message } = shellCloseToExit(
              event.code,
              event.reason,
              exitCode,
            );
            if (message !== null) process.stderr.write(`\n${message}\n`);
            if (mapped !== null) exitCode = mapped;
            resolve();
          });
        });

        await closed;
        if (exitCode !== 0) {
          const e = new Error(`shell exited ${exitCode}`) as Error & { exitCode: number };
          e.exitCode = exitCode;
          throw e;
        }
      }),
    { args: [{ slot: 0, resource: "servers" }] },
  );
}
