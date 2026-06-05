import type { Command } from "commander";
import { bootstrap } from "../client/bootstrap";
import { globalOutput, printObject, resolveFormat } from "../ui/output";
import { requireCapability, withCompletion } from "../client/command-meta";
import { detectCiContext } from "../ci/context";
import { execOnServer, requireAutomationKey, requireServerUuid } from "../ci/automation-client";

const SAFE_ARG_RE = /^[A-Za-z0-9._/@+-]+$/;

/** Reject values containing shell metacharacters before they are interpolated
 *  into server-side shell commands. Empty string is allowed (means "unset").
 *  Throws exit-2 on violation. */
export function assertSafeArg(value: string, label: string): void {
  if (value && !SAFE_ARG_RE.test(value)) {
    const e = new Error(
      `${label} contains characters that are not allowed: "${value}"`,
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  }
}

/** Build a git clone URL, deriving the host from CI context. Empty serverUrl
 *  defaults to github.com. With a token, embeds it as x-access-token. */
export function buildCloneUrl(serverUrl: string, repository: string, token: string): string {
  const base = (serverUrl || "https://github.com").replace(/\/$/, "");
  if (!token) return `${base}/${repository}.git`;
  const host = base.replace(/^https?:\/\//, "");
  return `https://x-access-token:${token}@${host}/${repository}.git`;
}

export function registerCheckout(program: Command): void {
  const cmd = withCompletion(program.command("checkout <serverId>"), {
    args: [{ slot: 0, resource: "servers" }],
  });
  requireCapability(cmd, "server:exec");
  cmd
    .description("clone or update a git repository on a Reoclo-managed server (CI)")
    .option("--repository <owner/repo>", "repository to checkout (defaults to CI context)")
    .option("--ref <ref>", "branch, tag, or SHA (defaults to CI commit SHA)")
    .option("--path <dir>", "directory on the server to checkout into", "/opt/deploy/workspace")
    .option("--token <token>", "token for repo access (defaults to $GITHUB_TOKEN)")
    .option("--clean", "remove the target directory before cloning", true)
    .option("--no-clean", "fetch into the existing directory instead of removing it")
    .option("--depth <n>", "clone depth (0 for full clone)", "1")
    .option("--submodules <mode>", "submodules: false | true | recursive", "false")
    .action(
      async (
        serverId: string,
        opts: {
          repository?: string;
          ref?: string;
          path?: string;
          token?: string;
          clean?: boolean;
          depth?: string;
          submodules?: string;
        },
      ) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        requireAutomationKey(ctx);
        const sid = requireServerUuid(serverId);

        const ci = detectCiContext();
        const repository = opts.repository ?? ci.runContext.repository;
        if (!repository) {
          const e = new Error("--repository is required (or run inside CI)") as Error & {
            exitCode: number;
          };
          e.exitCode = 2;
          throw e;
        }
        const ref = opts.ref ?? ci.runContext.sha ?? "";

        assertSafeArg(repository, "repository");
        assertSafeArg(ref, "ref");

        const token = opts.token ?? process.env.GITHUB_TOKEN ?? "";
        const targetPath = opts.path ?? "/opt/deploy/workspace";
        assertSafeArg(targetPath, "path");
        const clean = opts.clean !== false;
        const depth = Number.parseInt(opts.depth ?? "1", 10);
        const depthFlag = depth > 0 ? `--depth ${depth}` : "";
        const cloneUrl = buildCloneUrl(ci.scmServerUrl, repository, token);
        // Token-less URL written back to the server's git remote after any
        // clone/fetch, so a credential never lingers in the checked-out repo's
        // .git/config.
        const anonUrl = buildCloneUrl(ci.scmServerUrl, repository, "");

        const run = (command: string, timeoutSeconds: number) =>
          execOnServer(ctx.client, {
            server_id: sid,
            command,
            timeout_seconds: timeoutSeconds,
            run_id: ci.runId,
            run_context: ci.runContext,
          });

        if (clean) await run(`rm -rf "${targetPath}"`, 60);

        const dirCheck = await run(
          `test -d "${targetPath}/.git" && echo exists || echo missing`,
          15,
        ).catch(() => ({ stdout: "missing" }) as { stdout: string });
        const dirExists = dirCheck.stdout.trim() === "exists";

        if (dirExists && !clean) {
          await run(
            [
              `cd "${targetPath}"`,
              `git remote set-url origin "${cloneUrl}"`,
              `git fetch origin ${depthFlag}`,
              `git remote set-url origin "${anonUrl}"`,
            ].join(" && "),
            120,
          );
        } else {
          await run(
            [
              `mkdir -p "$(dirname "${targetPath}")"`,
              `git clone ${depthFlag} "${cloneUrl}" "${targetPath}"`,
              `cd "${targetPath}" && git remote set-url origin "${anonUrl}"`,
            ].join(" && "),
            300,
          );
        }

        if (ref) await run(`cd "${targetPath}" && git checkout --force "${ref}"`, 60);
        if (opts.submodules === "true")
          await run(`cd "${targetPath}" && git submodule update --init`, 120);
        else if (opts.submodules === "recursive")
          await run(`cd "${targetPath}" && git submodule update --init --recursive`, 300);

        const shaRes = await run(`cd "${targetPath}" && git rev-parse HEAD`, 15);
        const refRes = await run(`cd "${targetPath}" && git rev-parse --abbrev-ref HEAD`, 15);
        const result = {
          commit_sha: shaRes.stdout.trim(),
          ref: refRes.stdout.trim(),
          path: targetPath,
        };

        if (fmt === "json" || fmt === "yaml") {
          printObject(result, fmt);
        } else {
          process.stdout.write(
            `checked out ${repository}@${result.commit_sha.slice(0, 8)} into ${targetPath}\n`,
          );
        }
      },
    );
}
