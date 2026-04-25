// src/commands/shell.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveServer } from "../client/resolve";

export const SUBPROTOCOL_VERSION = "v1";

export function base64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function buildShellWsUrl(api: string, serverId: string): string {
  const trimmed = api.replace(/\/$/, "");
  const wsBase = trimmed.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return `${wsBase}/mcp/ws/terminal/${serverId}`;
}

export function buildShellSubprotocol(token: string): string {
  return `reoclo.api-key.${SUBPROTOCOL_VERSION}.${base64url(token)}`;
}

interface ShellOptions {
  allowNoTty?: boolean;
}

export function registerShell(program: Command): void {
  program
    .command("shell <serverIdOrName>")
    .description("open an interactive shell on a server via the runner")
    .option(
      "--allow-no-tty",
      "skip the TTY-required check (mostly for tests; bypasses raw mode)",
    )
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

      const wsUrl = buildShellWsUrl(ctx.api, serverId);
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
          // Map server-side WS close codes to CLI exit codes.
          if (event.code === 1000) {
            // Normal close — keep whatever exitCode the 'exited' frame set.
          } else if (event.code === 4001) {
            process.stderr.write(`\n[authentication failed: ${event.reason}]\n`);
            exitCode = 3;
          } else if (event.code === 4403) {
            process.stderr.write(`\n[forbidden: ${event.reason}]\n`);
            exitCode = 3;
          } else if (event.code === 4404) {
            process.stderr.write(`\n[not found: ${event.reason}]\n`);
            exitCode = 5;
          } else if (event.code === 4400) {
            process.stderr.write(`\n[bad request: ${event.reason}]\n`);
            exitCode = 2;
          } else if (event.code === 4408) {
            process.stderr.write(`\n[idle timeout]\n`);
            exitCode = 1;
          } else if (event.code !== 1005) {
            process.stderr.write(`\n[connection closed: ${event.code} ${event.reason}]\n`);
            if (exitCode === 0) exitCode = 1;
          }
          resolve();
        });
      });

      await closed;
      if (exitCode !== 0) {
        const e = new Error(`shell exited ${exitCode}`) as Error & { exitCode: number };
        e.exitCode = exitCode;
        throw e;
      }
    });
}
