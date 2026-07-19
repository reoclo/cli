import type { Command } from "commander";
import { bootstrap } from "../client/bootstrap";
import { globalOutput, printObject, resolveFormat } from "../ui/output";
import { requireCapability, withCompletion } from "../client/command-meta";
import { detectCiContext } from "../ci/context";
import { execOnServer, requireAutomationKey, requireServerUuid } from "../ci/automation-client";

const SAFE_ARG_RE = /^[A-Za-z0-9._/@+-]+$/;

function exitErr(message: string, code: number): Error & { exitCode: number } {
  const e = new Error(message) as Error & { exitCode: number };
  e.exitCode = code;
  return e;
}

/** Reject values containing shell metacharacters before they are interpolated
 *  into server-side shell commands. Empty string is allowed (means "unset").
 *  Throws exit-2 on violation. Used for repo/ref/path — values that are always
 *  safe-charset; free-form values (filter, sparse patterns) use {@link shellQuote}. */
export function assertSafeArg(value: string, label: string): void {
  if (value && !SAFE_ARG_RE.test(value)) {
    throw exitErr(`${label} contains characters that are not allowed: "${value}"`, 2);
  }
}

/** POSIX single-quote a value so it can be interpolated into a server-side shell
 *  command verbatim (close-quote, escaped-quote, reopen-quote for embedded `'`). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Build a git clone URL, deriving the host from CI context. Empty serverUrl
 *  defaults to github.com. With a token, embeds it as x-access-token. */
export function buildCloneUrl(serverUrl: string, repository: string, token: string): string {
  const base = (serverUrl || "https://github.com").replace(/\/$/, "");
  if (!token) return `${base}/${repository}.git`;
  const host = base.replace(/^https?:\/\//, "");
  return `https://x-access-token:${token}@${host}/${repository}.git`;
}

/** Flags for the `git fetch` of the requested ref: shallow depth, tags policy,
 *  optional partial-clone filter, always `--force`. */
export function buildFetchFlags(opts: { depth: number; fetchTags: boolean; filter: string }): string {
  return [
    opts.depth > 0 ? `--depth ${opts.depth}` : "",
    opts.fetchTags ? "--tags" : "--no-tags",
    opts.filter ? `--filter=${shellQuote(opts.filter)}` : "",
    "--force",
  ]
    .filter(Boolean)
    .join(" ");
}

function collectRepeatable(value: string, acc: string[] = []): string[] {
  acc.push(value);
  return acc;
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
    .option("--clean", "remove the target directory before fetching", true)
    .option("--no-clean", "fetch into the existing directory instead of removing it")
    .option("--depth <n>", "fetch depth for the ref (0 for full history)", "1")
    .option("--fetch-tags", "fetch tags as well as the ref, even when depth > 0", false)
    .option("--filter <filter>", "partial-clone filter applied to fetch (for example blob:none)", "")
    .option(
      "--sparse-checkout <pattern>",
      "sparse-checkout pattern (repeatable, enables sparse checkout)",
      collectRepeatable,
      [] as string[],
    )
    .option("--sparse-checkout-cone-mode <bool>", "use cone mode for sparse checkout", "true")
    .option("--submodules <mode>", "submodules: false | true | recursive", "false")
    .option("--lfs", "download Git LFS objects after checkout", false)
    .option(
      "--persist-credentials",
      "keep the access token in .git/config (default: scrub it for security)",
      false,
    )
    .option("--github-server-url <url>", "SCM base URL (for GHES, defaults to CI context)")
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
          fetchTags?: boolean;
          filter?: string;
          sparseCheckout?: string[];
          sparseCheckoutConeMode?: string;
          submodules?: string;
          lfs?: boolean;
          persistCredentials?: boolean;
          githubServerUrl?: string;
        },
      ) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        requireAutomationKey(ctx);
        const sid = requireServerUuid(serverId);

        const ci = detectCiContext();
        const repository = opts.repository ?? ci.runContext.repository;
        if (!repository) {
          throw exitErr("--repository is required (or run inside CI)", 2);
        }
        const ref = opts.ref ?? ci.runContext.sha ?? "";

        assertSafeArg(repository, "repository");
        assertSafeArg(ref, "ref");

        const token = opts.token ?? process.env.GITHUB_TOKEN ?? "";
        const targetPath = opts.path ?? "/opt/deploy/workspace";
        assertSafeArg(targetPath, "path");

        const clean = opts.clean !== false;
        const depth = Number.parseInt(opts.depth ?? "1", 10);
        const fetchTags = opts.fetchTags === true;
        const filter = opts.filter ?? "";
        const sparsePatterns = (opts.sparseCheckout ?? []).map((p) => p.trim()).filter(Boolean);
        const coneMode = (opts.sparseCheckoutConeMode ?? "true") !== "false";
        const submodules = opts.submodules ?? "false";
        const lfs = opts.lfs === true;
        const persist = opts.persistCredentials === true;

        // SCM host precedence: explicit flag → CI context → github.com (buildCloneUrl default).
        const serverUrl = opts.githubServerUrl ?? ci.scmServerUrl ?? "";
        if (opts.githubServerUrl) {
          try {
            new URL(opts.githubServerUrl);
          } catch {
            throw exitErr(`--github-server-url is not a valid URL: "${opts.githubServerUrl}"`, 2);
          }
        }
        const authedUrl = buildCloneUrl(serverUrl, repository, token);
        const bareUrl = buildCloneUrl(serverUrl, repository, "");

        const run = async (command: string, timeoutSeconds: number) => {
          const r = await execOnServer(ctx.client, {
            server_id: sid,
            command,
            timeout_seconds: timeoutSeconds,
            run_id: ci.runId,
            run_context: ci.runContext,
          });
          // Fail loudly on a non-zero server-side exit. Without this, a failed
          // git step (e.g. an unwritable path or unreachable remote) was silently
          // ignored and checkout returned exit 0 with an empty commit_sha.
          if (r.exit_code !== 0) {
            const detail = (r.stderr || r.stdout || "").trim();
            throw exitErr(
              `checkout step failed on server (exit ${r.exit_code})` +
                (detail ? `: ${detail}` : ""),
              r.exit_code || 1,
            );
          }
          return r;
        };

        // 1. Clean to a known-empty state if requested.
        if (clean) await run(`rm -rf "${targetPath}"`, 60);

        // 2. Initialize a fresh repo, or reuse an existing one (incremental updates).
        const dirCheck = await run(
          `test -d "${targetPath}/.git" && echo exists || echo missing`,
          15,
        ).catch(() => ({ stdout: "missing" }) as { stdout: string });
        const dirExists = dirCheck.stdout.trim() === "exists";

        if (!dirExists) {
          await run(
            [
              `mkdir -p "${targetPath}"`,
              `cd "${targetPath}"`,
              `git init -q`,
              `git remote add origin "${authedUrl}"`,
            ].join(" && "),
            60,
          );
        } else {
          // Refresh the remote URL in case the token rotated between runs.
          await run(`cd "${targetPath}" && git remote set-url origin "${authedUrl}"`, 30);
        }

        // 3. Configure sparse checkout before fetching so a filter can skip blobs.
        if (sparsePatterns.length > 0) {
          const coneFlag = coneMode ? "--cone" : "--no-cone";
          const patternsArg = sparsePatterns.map(shellQuote).join(" ");
          await run(
            [
              `cd "${targetPath}"`,
              `git sparse-checkout init ${coneFlag}`,
              `git sparse-checkout set ${patternsArg}`,
            ].join(" && "),
            60,
          );
        }

        // 4. Fetch the requested ref directly (resolves any SHA on any branch, even shallow).
        const fetchTarget = ref || "HEAD";
        const fetchFlags = buildFetchFlags({ depth, fetchTags, filter });
        await run(
          `cd "${targetPath}" && git fetch ${fetchFlags} origin ${shellQuote(fetchTarget)}`,
          300,
        );

        // 5. Detached checkout of the fetched commit.
        await run(`cd "${targetPath}" && git checkout --force --detach FETCH_HEAD`, 60);

        // 6. Submodules.
        if (submodules === "true") {
          await run(`cd "${targetPath}" && git submodule update --init`, 120);
        } else if (submodules === "recursive") {
          await run(`cd "${targetPath}" && git submodule update --init --recursive`, 300);
        }

        // 7. Git LFS (no-op if the repo has no LFS objects).
        if (lfs) {
          await run(
            [`cd "${targetPath}"`, `git lfs install --local`, `git lfs pull`].join(" && "),
            600,
          );
        }

        // 8. Scrub the token from the server's .git/config unless explicitly persisted.
        if (!persist && token) {
          await run(`cd "${targetPath}" && git remote set-url origin "${bareUrl}"`, 30);
        }

        // 9. Resolve outputs.
        const shaRes = await run(`cd "${targetPath}" && git rev-parse HEAD`, 15);
        const commitSha = shaRes.stdout.trim();
        const result = {
          commit_sha: commitSha,
          commit: commitSha,
          short_sha: commitSha.slice(0, 7),
          ref: ref || commitSha,
          path: targetPath,
        };

        if (fmt === "json" || fmt === "yaml") {
          printObject(result, fmt);
        } else {
          process.stdout.write(
            `checked out ${repository}@${commitSha.slice(0, 8)} into ${targetPath}\n`,
          );
        }
      },
    );
}
