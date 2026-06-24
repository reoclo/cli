// src/secrets/sources/bitwarden.ts
//
// Import source adapter #1: Bitwarden Secrets Manager. Shells out to the
// user's official `bws` CLI (which decrypts values locally) and normalizes
// the result. reoclo never reads or stores the user's BWS_ACCESS_TOKEN — it
// only inherits the ambient env into the child process.

import type { CommandResult, CommandRunner } from "./exec";
import type { ImportedSecret, SecretSource } from "../types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BwsSecret {
  key: string;
  value: string;
  note?: string | null;
}
interface BwsProject {
  id: string;
  name: string;
}

export interface BitwardenOptions {
  /** Optional BWS project scope — a UUID (used directly) or a name (resolved). */
  bwsProject?: string;
}

export interface BitwardenDeps {
  run: CommandRunner;
  env: Record<string, string | undefined>;
}

export function bitwardenSource(opts: BitwardenOptions, deps: BitwardenDeps): SecretSource {
  return {
    name: "bitwarden",
    read: () => readBitwarden(opts, deps),
  };
}

async function readBitwarden(
  opts: BitwardenOptions,
  deps: BitwardenDeps,
): Promise<ImportedSecret[]> {
  if (!deps.env.BWS_ACCESS_TOKEN) {
    const e = new Error(
      "BWS_ACCESS_TOKEN is not set — export your Bitwarden Secrets Manager access token before importing.",
    ) as Error & { exitCode: number };
    e.exitCode = 4;
    throw e;
  }

  const args = ["secret", "list"];
  if (opts.bwsProject) {
    const id = UUID.test(opts.bwsProject)
      ? opts.bwsProject
      : await resolveBwsProjectId(opts.bwsProject, deps);
    args.push(id);
  }
  args.push("--output", "json");

  const res = await runBws(args, deps);
  const secrets = parseJson<BwsSecret[]>(res.stdout, "bws secret list");
  return secrets.map((s) => ({ key: s.key, value: s.value, note: s.note ?? null }));
}

async function resolveBwsProjectId(name: string, deps: BitwardenDeps): Promise<string> {
  const res = await runBws(["project", "list", "--output", "json"], deps);
  const projects = parseJson<BwsProject[]>(res.stdout, "bws project list");
  const matches = projects.filter((p) => p.name === name);
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) {
    throw new Error(`no Bitwarden project named "${name}"`);
  }
  throw new Error(
    `multiple Bitwarden projects named "${name}" — pass the project id instead`,
  );
}

async function runBws(args: string[], deps: BitwardenDeps): Promise<CommandResult> {
  let res: CommandResult;
  try {
    res = await deps.run(["bws", ...args], { env: deps.env });
  } catch (e) {
    if (e && typeof e === "object" && (e as { code?: string }).code === "ENOENT") {
      throw new Error(
        'the "bws" CLI was not found — install Bitwarden Secrets Manager CLI: https://bitwarden.com/help/secrets-manager-cli/',
      );
    }
    throw e;
  }
  if (res.code !== 0) {
    const detail = res.stderr.trim() || res.stdout.trim() || `exit code ${res.code}`;
    throw new Error(`bws ${args[0]} failed: ${detail}`);
  }
  return res;
}

function parseJson<T>(stdout: string, what: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`could not parse ${what} output as JSON`);
  }
}
